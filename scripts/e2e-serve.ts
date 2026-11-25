/**
 * E2E environment orchestrator: synthetic xochitl store -> rmsyncd (--no-dbus,
 * sync agent) pushes to weft-cloud -> browser talks only to the cloud, single
 * origin, no tablet. Runs as Playwright's `webServer`; readiness port (9101)
 * opens only after the store has fully seeded, so tests never race the push.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ROOT = join(import.meta.dir, '..')
const BUN = join(homedir(), '.bun/bin/bun')
const CLOUD_PORT = 9100
const READY_PORT = 9101
const CLOUD = `http://localhost:${CLOUD_PORT}`
const USER = 'e2e'
const AUTH = { authorization: `Bearer dev:${USER}` }
const STORE = join(ROOT, '.dev-store')

// Pages with ink that must exist before tests run; PDF/EPUB pages have no .rm and aren't gated on.
const SEEDED_PAGES: [string, string][] = [
    ['11111111-1111-4111-a111-111111111111', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'],
    ['22222222-2222-4222-a222-222222222222', 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'],
    ['44444444-4444-4444-a444-444444444444', 'dddddddd-dddd-4ddd-addd-dddddddddddd'],
    ['88888888-8888-4888-a888-888888888888', '99999999-9999-4999-a999-999999999999'],
    ['bbbb0001-0000-4000-a000-0000000000bb', 'bbbb0002-0000-4000-a000-0000000000bb'],
    ['dddd0001-0000-4000-a000-0000000000dd', 'dddd0002-0000-4000-a000-0000000000dd'],
]
const SEEDED_TEMPLATE = 'P Lines small'
const SEEDED_ASSET = [
    '88888888-8888-4888-a888-888888888888',
    '99999999-9999-4999-a999-999999999999',
    'ab1e0001-0000-4000-a000-0000000000ab.png',
] as const

const children: ChildProcess[] = []
function killAll(): void {
    for (const c of children) c.kill('SIGTERM')
}
for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) {
    process.on(sig, killAll)
}

async function waitFor(label: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
    const deadline = Date.now() + ms
    for (;;) {
        try {
            if (await fn()) return
        } catch {
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
        await new Promise((r) => setTimeout(r, 200))
    }
}

async function main(): Promise<void> {
    // 1. synthetic store
    const mk = spawnSync(BUN, ['scripts/make-dev-store.ts'], {
        cwd: ROOT,
        stdio: 'inherit',
    })
    if (mk.status !== 0) throw new Error('make-dev-store failed')

    // 2. cloud server (dev auth + serves the SPA single-origin)
    children.push(
        spawn(
            BUN,
            [
                'apps/cloud/src/server.ts',
                '--port',
                String(CLOUD_PORT),
                '--db',
                ':memory:',
                '--static-dir',
                'apps/web/build',
            ],
            {
                cwd: ROOT,
                env: { ...process.env, CLOUD_DEV_USER: '1' },
                stdio: 'inherit',
            },
        ),
    )
    await waitFor('cloud health', async () => (await fetch(`${CLOUD}/api/health`)).ok)

    // 3. mint a device token for the e2e user (as the web pairing flow would)
    const pair = await fetch(`${CLOUD}/api/pair`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'e2e-tablet' }),
    })
    const { token } = (await pair.json()) as { token: string }
    writeFileSync(join(STORE, 'cloud.json'), JSON.stringify({ url: CLOUD, token }))

    // 4. daemon as sync agent: pushes the store, then is killed once seeded
    //    (else it would pull/re-push the app's own cloud writes mid-test).
    const daemon = spawn(
        'device/target/release/rmsyncd',
        [
            '--no-dbus',
            '--xochitl-dir',
            join(STORE, 'xochitl'),
            '--templates-dir',
            join(STORE, 'templates'),
            '--cloud-config',
            join(STORE, 'cloud.json'),
        ],
        { cwd: ROOT, env: { ...process.env }, stdio: 'inherit' },
    )
    children.push(daemon)

    // 5. wait until the store has fully reconciled into the cloud
    const get = (p: string) => fetch(`${CLOUD}${p}`, { headers: AUTH })
    await waitFor('documents seeded', async () => {
        const docs = (await (await get('/api/documents')).json()) as {
            documents: { id: string; name?: string }[]
        }
        // gate on non-empty name too: specs assert on doc names.
        return SEEDED_PAGES.every(([d]) => {
            const doc = docs.documents.find((x) => x.id === d)
            return !!doc && typeof doc.name === 'string' && doc.name.length > 0
        })
    })
    for (const [doc, page] of SEEDED_PAGES) {
        await waitFor(
            `page ${doc}/${page}`,
            async () => (await get(`/api/documents/${doc}/pages/${page}/rm`)).ok,
        )
    }
    await waitFor(
        'template seeded',
        async () => (await get(`/api/templates/${encodeURIComponent(SEEDED_TEMPLATE)}`)).ok,
    )
    await waitFor('image asset seeded', async () => {
        const [doc, page, file] = SEEDED_ASSET
        return (await get(`/api/documents/${doc}/pages/${page}/assets/${file}`)).ok
    })

    // 5b. seeding done: stop the daemon
    daemon.kill('SIGTERM')

    // 6. open the readiness gate Playwright waits on
    Bun.serve({ port: READY_PORT, fetch: () => new Response('ready') })
    console.log(`e2e env ready: app at ${CLOUD}, readiness at http://localhost:${READY_PORT}`)
}

main().catch((e) => {
    console.error('e2e-serve failed:', e)
    killAll()
    process.exit(1)
})
