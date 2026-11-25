/**
 * Probe generator for isolating xochitl hangs. Builds a mutated page variant
 * per flags:
 *   --timestamp=item|root      (item = timestamp == itemId)
 *   --left=file|doc            (file = last line block in file order)
 *   --author=existing|new      (existing = reuse author 2 uuid, no table edit)
 *   --normalize                (apply xochitl-layout sort; default off)
 *
 * Usage: bun device-probe.ts <in.rm> <out.rm> [flags]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { RmDocument } from '../src/document'
import { Pen, PenColor, type Point } from '../src/scene-items'
import { crdtId, END_MARKER, type CrdtId } from '../src/crdt-id'
import type { SceneLineItemBlock } from '../src/blocks'

const args = process.argv.slice(2)
const [input, output] = args
const flag = (name: string, dflt: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt
const timestampMode = flag('timestamp', 'item')
const leftMode = flag('left', 'file')
const authorMode = flag('author', 'existing')
const normalize = args.includes('--normalize')

const doc = RmDocument.parse(new Uint8Array(readFileSync(input!)))

// author
let authorUuid: string
if (authorMode === 'existing') {
    const table = doc.authorTable()
    authorUuid = table.get(2) ?? [...table.values()][0]!
} else {
    authorUuid = 'c8050a7c-0000-4000-a000-000000000001'
}
const authorIndex = doc.resolveAuthor(authorUuid)

// leftId
let leftId: CrdtId = END_MARKER
if (leftMode === 'file') {
    for (const b of doc.blocks) {
        if (b.type === 'sceneLineItem') leftId = b.itemId
    }
} else {
    leftId = doc.lastItemIdUnder(doc.defaultLayerId()!)
}

const clock = doc.maxClock(authorIndex) + 1
const itemId = crdtId(authorIndex, clock)

const points: Point[] = []
for (let i = 0; i <= 60; i++) {
    const t = i / 60
    points.push({ x: 120 + t * 1100, y: 220 + t * 1300, speed: 8, direction: 96, width: 80, pressure: 180 })
}

const block: SceneLineItemBlock = {
    type: 'sceneLineItem',
    version: { min: 0, current: 2 },
    extraData: new Uint8Array(0),
    extraValueData: new Uint8Array(0),
    parentId: doc.defaultLayerId()!,
    itemId,
    leftId,
    rightId: END_MARKER,
    deletedLength: 0,
    line: {
        kind: 'line',
        tool: Pen.MARKER_2,
        color: PenColor.BLACK,
        thicknessScale: 2,
        startingLength: 0,
        timestamp: timestampMode === 'item' ? itemId : crdtId(0, 1),
        moveId: null,
        points,
    },
}
doc.blocks.push(block)
if (normalize) doc.normalizeLayout()

const bytes = doc.serialize()
writeFileSync(output!, bytes)
console.log(JSON.stringify({ timestampMode, leftMode, authorMode, normalize, itemId, leftId, bytes: bytes.length }))
