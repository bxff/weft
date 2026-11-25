import { expect, test } from 'bun:test'
import { RmDocument, type RmBlock } from '../src/index'
import { ANCHOR_TEXT_END, RESERVED_CLOCK_FLOOR, lww, crdtId } from '../src/crdt-id'

const AUTHOR = 'aaaaaaaa-0000-4000-a000-000000000001'

function line() {
    return {
        kind: 'line' as const, tool: 2, color: 0, thicknessScale: 2,
        startingLength: 0, moveId: null, timestamp: crdtId(0, 1),
        points: [{ x: 0, y: 0, speed: 0, direction: 0, width: 8, pressure: 1 }],
    }
}

// A page with handwriting anchored to text stores the anchor sentinels
// ANCHOR_TEXT_START/END (2^48-2 / 2^48-1). If maxClock() treats those as
// real clocks, the next minted stroke gets clock 2^48, which overflows the
// 48-bit clock field and never stabilizes across an .rm round-trip
// (re-added on every sync). maxClock must ignore the reserved range.

test('maxClock ignores the reserved text-anchor sentinels', () => {
    const doc = RmDocument.empty(AUTHOR)
    doc.appendLine(line(), { authorUuid: AUTHOR })
    const clean = doc.maxClock()
    expect(clean).toBeLessThan(RESERVED_CLOCK_FLOOR)

    // Simulate handwriting anchored to text: a group block carrying
    // anchorId = ANCHOR_TEXT_END (2^48-1), exactly as the bug page's snapshot.
    ;(doc as unknown as { blocks: unknown[] }).blocks.push({
        type: 'sceneGroupItem',
        itemId: crdtId(0, 0), parentId: crdtId(0, 0),
        anchorId: lww(crdtId(0, 0), ANCHOR_TEXT_END),
    })

    // The sentinel must NOT raise the max — otherwise every later id is poisoned.
    expect(doc.maxClock()).toBe(clean)
})

test('a stroke minted on an anchored-text page gets a real clock, not 2^48', () => {
    const doc = RmDocument.empty(AUTHOR)
    ;(doc as unknown as { blocks: unknown[] }).blocks.push({
        type: 'sceneGroupItem',
        itemId: crdtId(0, 0), parentId: crdtId(0, 0),
        anchorId: lww(crdtId(0, 0), ANCHOR_TEXT_END),
    })
    const block = doc.appendLine(line(), { authorUuid: AUTHOR })
    expect(block.itemId.part2).toBeLessThan(RESERVED_CLOCK_FLOOR)
})

const deletedKinds = [
    { type: 'sceneLineItem', line: null },
    { type: 'sceneGlyphItem', glyph: null },
    { type: 'sceneImageItem', image: null },
    { type: 'sceneGroupItem', nodeId: null },
    { type: 'sceneTombstoneItem' },
] as const

for (const payload of deletedKinds) {
    test(`new strokes start after the entire deleted ${payload.type} range`, () => {
        for (const length of [1, 100, 0xffffffff]) {
            const doc = RmDocument.empty(AUTHOR)
            const deleted: RmBlock = {
                ...payload,
                version: { min: 0, current: 2 },
                extraData: new Uint8Array(0),
                extraValueData: new Uint8Array(0),
                parentId: payload.type === 'sceneGroupItem' ? crdtId(0, 1) : doc.defaultLayerId()!,
                itemId: crdtId(1, 100),
                leftId: crdtId(0, 0),
                rightId: crdtId(0, 0),
                deletedLength: length,
            }
            doc.blocks.push(deleted)
            const bytes = doc.serialize()
            const parsed = RmDocument.parse(bytes)
            expect(parsed.maxClock()).toBe(100 + length - 1)
            expect(parsed.serialize()).toEqual(bytes)

            // The allocation clock is global, including when a new author joins.
            for (const author of [AUTHOR, 'bbbbbbbb-0000-4000-a000-000000000002']) {
                const edited = RmDocument.parse(bytes)
                const added = edited.appendLine(line(), { authorUuid: author })
                expect(added.itemId.part2).toBe(100 + length)
                expect(RmDocument.parse(edited.serialize()).maxClock()).toBe(100 + length)
            }
        }
    })
}
