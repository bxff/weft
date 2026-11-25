/** Run with: bun scripts/benchmark-ink-move.ts [path/to/page.rm]
 * Measures synchronous native conversion only, excluding parse, rendering,
 * network and serialization. Use the same file/script on both revisions. */
import { readFileSync } from 'node:fs'
import { RmDocument } from '../packages/rm-format/src/index'
import { applyOps, type LocalOp } from '../packages/sync-engine/src/apply-ops'
import { RefResolver } from '../packages/sync-engine/src/refs'

const fixture = process.argv[2] ?? 'fixtures/mako-p1.rm'
const bytes = readFileSync(fixture)
const base = RmDocument.parse(bytes)
const refs = new RefResolver(base)
const items: Extract<LocalOp, { type: 'transform-ink' }>['items'] = []
let points = 0
for (const [id, item] of base.tree().walk()) {
    if (item.kind !== 'line') continue
    const ref = refs.toRef(id)
    if (!ref) continue
    points += item.points.length
    items.push({ ref, points: item.points.map(p => ({ ...p, x: p.x + 24.125, y: p.y - 11.125 })) })
}
if (!items.length) throw new Error('The fixture contains no movable native ink')

const elapsed: number[] = []
let expectedDigest: string | undefined
for (let i = 0; i < 4; i++) {
    const doc = RmDocument.parse(bytes)
    const start = performance.now()
    const result = applyOps(doc, { shapes: [] }, [{ type: 'transform-ink', items }], {
        authorUuid: '9bd69700-0000-4000-a000-000000000001',
    })
    const ms = performance.now() - start
    const digest = new Bun.CryptoHasher('sha256')
        .update(doc.serialize()).update(JSON.stringify(result)).digest('hex')
    if (expectedDigest && expectedDigest !== digest) throw new Error('Non-deterministic output')
    expectedDigest = digest
    if (i > 0) elapsed.push(ms)
    console.log(JSON.stringify({ fixture, strokes: items.length, points, deltas: result.deltas.length,
        ms, digest, warmup: i === 0 }))
}
elapsed.sort((a, b) => a - b)
console.log(JSON.stringify({ medianMs: elapsed[1], digest: expectedDigest }))
