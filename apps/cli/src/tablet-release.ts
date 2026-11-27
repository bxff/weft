import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'

const REPO = 'https://github.com/bxff/weft/releases'
const LIMIT = 64 * 1024 * 1024
const DOMAIN = 'weft-tablet-release-v1'
export type Arch = 'armv7' | 'aarch64'

export function verifyManifest(manifest: Uint8Array, signature: Uint8Array, pin: string, tag: string, arch: Arch) {
    if (!/^[a-f0-9]{64}$/.test(pin)) throw Error('No trusted tablet release key is configured')
    const key = createPublicKey({
        key: Buffer.from('302a300506032b6570032100' + pin, 'hex'),
        format: 'der', type: 'spki',
    })
    if (signature.length !== 64 || !verify(null, manifest, key, signature)) throw Error('Invalid tablet release signature')
    const body = Buffer.from(manifest).toString('utf8')
    const lines = body.split('\n')
    if (lines.length !== 5 || lines[0] !== DOMAIN || lines[1] !== tag || lines[4] !== '' || !/^tablet-v[1-9][0-9]{0,14}$/.test(tag)) throw Error('Invalid tablet release manifest')
    const entries = (['aarch64', 'armv7'] as const).map((name, i) => {
        const m = /^([a-f0-9]{64}) ([1-9][0-9]{0,7}) (rmsyncd-(?:aarch64|armv7))$/.exec(lines[i + 2]!)
        if (!m || m[3] !== `rmsyncd-${name}` || Number(m[2]) > LIMIT) throw Error('Invalid tablet release asset')
        return { sha: m[1]!, size: Number(m[2]), name: m[3]! }
    })
    return entries[arch === 'aarch64' ? 0 : 1]!
}

export function verifyBinary(bytes: Uint8Array, asset: { sha: string; size: number }, arch: Arch) {
    if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha) throw Error('Tablet binary does not match the signed release')
    const arm = arch === 'armv7'
    // Little-endian ARM32 EABI hard-float, or AArch64 ELF64.
    if (bytes.length < (arm ? 52 : 64) || Buffer.from(bytes.subarray(0, 4)).toString('hex') !== '7f454c46' ||
        bytes[4] !== (arm ? 1 : 2) || bytes[5] !== 1 || bytes[6] !== 1 ||
        bytes[18] !== (arm ? 40 : 183) || bytes[19] !== 0 ||
        (arm && (!(bytes[37]! & 4) || bytes[39] !== 5))) throw Error('Wrong tablet binary architecture')
}

async function bounded(res: Response, maximum: number): Promise<Buffer> {
    if (!res.ok || !res.body) throw Error(`GitHub tablet asset request failed: HTTP ${res.status}`)
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let n = 0
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            n += value.length
            if (n > maximum) throw Error('GitHub tablet asset exceeds size limit')
            chunks.push(value)
        }
    } finally { await reader.cancel() }
    return Buffer.concat(chunks, n)
}

export async function downloadVerifiedDaemon(arch: Arch) {
    const pin = readFileSync(new URL('./tablet-release-key.txt', import.meta.url), 'utf8').trim()
    if (!/^[a-f0-9]{64}$/.test(pin)) throw Error('No trusted tablet release key is configured; build from source or use a verified newer CLI')
    const signal = AbortSignal.timeout(120_000)
    const latest = await fetch('https://api.github.com/repos/bxff/weft/releases/latest', { signal })
    const { tag_name: tag } = JSON.parse((await bounded(latest, 512 * 1024)).toString()) as { tag_name: string }
    if (!/^tablet-v[1-9][0-9]{0,14}$/.test(tag)) throw Error('No stable tablet release is configured')
    const read = async (name: string, max: number) => bounded(await fetch(`${REPO}/download/${tag}/${name}`, { signal }), max)
    const [manifest, signature] = await Promise.all([read('tablet-release.txt', 1024), read('tablet-release.sig', 64)])
    const asset = verifyManifest(manifest, signature, pin, tag, arch)
    const bytes = await read(asset.name, asset.size)
    verifyBinary(bytes, asset, arch)
    return { bytes, sha: asset.sha }
}
