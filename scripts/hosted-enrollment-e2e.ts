import { generateKeyPairSync, sign } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const kid = 'synthetic-weft-enrollment'
const keys = [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }]
const original = globalThis.fetch
// Only the provider's key lookup is simulated. No network is permitted from
// the synthetic Clerk control; normal local HTTP still uses the real relay.
globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (url.origin === 'https://api.clerk.com' && url.pathname === '/v1/jwks') return Response.json({ keys })
        if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
            throw Error('external service prohibited in fixture')
        return original(input, options)
    },
    { preconnect: original.preconnect },
)
function jwt(sub: string, exp: number) {
    const now = Math.floor(Date.now() / 1000),
        part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const unsigned =
        part({ alg: 'RS256', kid, typ: 'JWT' }) +
        '.' +
        part({
            sub,
            iss: 'https://synthetic-clerk.example.invalid',
            sid: 'sess_' + sub,
            nbf: now - 10,
            iat: now,
            exp: now + exp,
        })
    return unsigned + '.' + sign('sha256', Buffer.from(unsigned), privateKey).toString('base64url')
}
process.env.CLERK_SECRET_KEY = 'sk_test_fixture_never_sent_externally'
process.env.HOST = '127.0.0.1'
process.env.WEFT_CAPACITY_BYTES = '10000'
delete process.env.CLOUD_DEV_USER
delete process.env.WEFT_PASSWORD
delete process.env.WEFT_BACKUP_DIR
const { startCloud } = await import('../apps/cloud/src/server.ts')
const scratch = process.argv[2]
if (!scratch) throw Error('Missing enrollment fixture directory')
const cloud = startCloud({ port: 0, db: join(scratch, 'relay.db'), staticDir: 'apps/web/build' })
const incomplete = join(scratch, 'ready.incomplete')
writeFileSync(
    incomplete,
    JSON.stringify({
        port: cloud.port,
        keys: {
            owner: jwt('owner', 480),
            peer: jwt('peer', 480),
            fresh: jwt('fresh', 480),
            expired: jwt('fresh', -180),
        },
    }),
    { mode: 0o600 },
)
renameSync(incomplete, join(scratch, 'ready.json'))
process.on('SIGTERM', () => {
    cloud.stop()
    cloud.store['db'].close()
    process.exit(0)
})
