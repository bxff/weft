import { expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { verifyManifest, verifyBinary } from '../src/tablet-release.ts'

test('tablet release requires a pinned signature, exact tag, bytes and architecture', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pin = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
    const arm64 = Buffer.alloc(64)
    Buffer.from('7f454c46020101', 'hex').copy(arm64)
    arm64[18] = 183
    const armv7 = Buffer.alloc(52)
    Buffer.from('7f454c46010101', 'hex').copy(armv7)
    armv7[18] = 40
    armv7[37] = 4
    armv7[39] = 5
    const tag = 'tablet-v2'
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
    const manifest = Buffer.from(`weft-tablet-release-v1\n${tag}\n${sha(arm64)} 64 rmsyncd-aarch64\n${sha(armv7)} 52 rmsyncd-armv7\n`)
    const signature = sign(null, manifest, privateKey)
    const a = verifyManifest(manifest, signature, pin, tag, 'aarch64')
    const b = verifyManifest(manifest, signature, pin, tag, 'armv7')
    expect(a.name).toBe('rmsyncd-aarch64')
    expect(b.name).toBe('rmsyncd-armv7')
    expect(() => verifyBinary(arm64, a, 'aarch64')).not.toThrow()
    expect(() => verifyBinary(armv7, b, 'armv7')).not.toThrow()
    expect(() => verifyManifest(manifest, signature, '0'.repeat(64), tag, 'aarch64')).toThrow()
    expect(() => verifyManifest(manifest, signature, pin, 'tablet-v3', 'aarch64')).toThrow()
    expect(() => verifyManifest(Buffer.concat([manifest, Buffer.from('x')]), signature, pin, tag, 'aarch64')).toThrow()
    expect(() => verifyBinary(arm64, a, 'armv7')).toThrow()
    arm64[63] = 1
    expect(() => verifyBinary(arm64, a, 'aarch64')).toThrow()
})
