/**
 * Does xochitl accept a file fully re-serialized and mutated by our codec?
 * Mutation: append one large diagonal MARKER_2 stroke with a weft author
 * UUID, normalize layout, serialize whole-doc.
 *
 * Run:  bun packages/rm-format/test/device-spike-o1.ts <in.rm> <out.rm>
 * Then: upload out.rm to the tablet, restart xochitl, check journal.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { RmDocument } from '../src/document'
import { Pen, PenColor, type Point } from '../src/scene-items'
import { crdtId } from '../src/crdt-id'

const WEFT_AUTHOR_UUID = 'c805ha7c-0000-4000-a000-000000000001'.replace('ha', '0a')

const [, , input, output] = process.argv
if (!input || !output) throw new Error('usage: bun device-spike-o1.ts <in.rm> <out.rm>')

const doc = RmDocument.parse(new Uint8Array(readFileSync(input)))

// Big visible diagonal stroke across the page (rM page coords ~1404x1872)
const points: Point[] = []
for (let i = 0; i <= 60; i++) {
    const t = i / 60
    points.push({
        x: 120 + t * 1100,
        y: 220 + t * 1300,
        speed: 8,
        direction: 96,
        width: 120,
        pressure: 180,
    })
}

const block = doc.appendLine(
    {
        kind: 'line',
        tool: Pen.MARKER_2,
        color: PenColor.BLACK,
        thicknessScale: 8,
        startingLength: 0,
        timestamp: crdtId(0, 1),
        moveId: null,
        points,
    },
    { authorUuid: WEFT_AUTHOR_UUID },
)

doc.normalizeLayout()
const bytes = doc.serialize()
writeFileSync(output, bytes)

// Re-parse sanity before touching the device
const reparsed = RmDocument.parse(bytes)
const raw = reparsed.blocks.filter((b) => b.type === 'raw')
console.log(
    JSON.stringify({
        newItem: block.itemId,
        authorIndex: block.itemId.part1,
        authors: [...reparsed.authorTable()],
        bytes: bytes.length,
        rawBlocks: raw.length,
    }),
)
if (raw.length > 0) throw new Error('self-check failed: raw blocks after mutation')
