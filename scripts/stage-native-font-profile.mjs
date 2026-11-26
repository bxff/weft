// Stage a hash-pinned data bundle. It never evaluates source or extracts paths.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const [archive, expected, overrideRoot] = process.argv.slice(2)
if (!archive || !/^[a-f0-9]{64}$/.test(expected ?? '')) {
    throw new Error('Supply a profile bundle and its expected SHA-256')
}
if (statSync(archive).size > 2_000_000) throw new Error('Font profile bundle too large')
const bytes = readFileSync(archive)
if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error('Native font profile checksum mismatch')
}
const profile = JSON.parse(gunzipSync(bytes, { maxOutputLength: 3_000_000 }).toString('utf8'))
const names = ['regular','medium','bold','italic','bold-italic','serif','serif-bold']
const staticKeys = ['sansRegular','sansMedium','sansBold','sansItalic','sansBoldItalic','serifSmall','serifSmallBold']
const hintedKeys = ['sans32','med36','bold32','ital32','serif46','serif64']
const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const exact = (x,k) => record(x) && Object.keys(x).length === k.length && k.every(y=>Object.hasOwn(x,y))

function table(x, allowed, bound) {
    if (!record(x) || Object.keys(x).length === 0 ||
        Object.entries(x).some(([name, values]) => !allowed.includes(name) || !record(values) ||
            Object.keys(values).length > 20000 || Object.entries(values).some(([c, n]) =>
                !c || [...c].length > 2 || typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > bound))) {
        throw new Error('Invalid native font spacing table')
    }
}
if (!exact(profile, ['version', 'fonts', 'advances', 'staticAdvances', 'kerning']) ||
    profile.version !== 1 || !exact(profile.fonts, names)) throw new Error('Invalid native font profile schema')
table(profile.advances, hintedKeys, 10)
table(profile.staticAdvances, staticKeys, 10)
table(profile.kerning, staticKeys, 2000)
const fonts = names.map((slot) => {
    const b64 = profile.fonts[slot]
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('Invalid font encoding')
    const data = Buffer.from(b64, 'base64')
    if (data.length < 1024 || data.length > 350_000 || data.readUInt32BE(0) !== 0x00010000) {
        throw new Error('Expected a bounded TrueType file')
    }
    return [slot, data]
})

const root = overrideRoot ? resolve(overrideRoot) : dirname(dirname(fileURLToPath(import.meta.url)))
const fontsDir = join(root, 'apps/web/static/fonts/native-profile')
mkdirSync(fontsDir, { recursive: true })
for (const [slot, data] of fonts) writeFileSync(join(fontsDir, slot + '.ttf'), data)
// Write the enabling manifest last. The default checked-in value is null.
const { advances, staticAdvances, kerning } = profile
writeFileSync(join(root, 'apps/web/src/lib/tldraw/native-font-profile.generated.json'),
    JSON.stringify({ advances, staticAdvances, kerning }) + '\n')
