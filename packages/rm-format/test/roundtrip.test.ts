/**
 * Round-trip regression tests against real tablet fixtures.
 *
 * The strong invariant: re-serializing a parsed file reproduces it BYTE-EXACT.
 * Fixtures are real files from a Paper Pro:
 *  - ferrari-xochitl-rewritten-merge.rm : written by xochitl itself after a
 *    CRDT merge (canonical layout, 5514 line blocks, tombstones, merged
 *    author table, unknown SceneInfo tag-6 field)
 *  - ferrari-poc-append-history.rm     : append-order file with 12 AuthorIds
 *    blocks and interleaved authors
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BlockType, readBlocks, writeBlocks, type RmBlock } from '../src/blocks'
import { RmDocument } from '../src/document'
import { Pen, PenColor } from '../src/scene-items'
import { crdtId } from '../src/crdt-id'
import { TaggedBlockWriter } from '../src/tagged-block'

const FIXTURES = join(import.meta.dir, '../../../fixtures')

function fixture(name: string): Uint8Array {
    return new Uint8Array(readFileSync(join(FIXTURES, name)))
}

const FIXTURE_NAMES = [
    'ferrari-xochitl-rewritten-merge.rm',
    'ferrari-poc-append-history.rm',
]

describe('byte-exact round-trip', () => {
    test('native v1 point retains its fractional width', () => {
        const writer = new TaggedBlockWriter()
        const end = crdtId(0, 0)
        const itemId = crdtId(1, 2)
        writer.writeHeader()
        writer.block(BlockType.SceneLineItem, 0, 1, () => {
            writer.writeId(1, crdtId(1, 1))
            writer.writeId(2, itemId)
            writer.writeId(3, end)
            writer.writeId(4, end)
            writer.writeInt(5, 0)
            writer.subblock(6, () => {
                writer.data.writeUint8(3)
                writer.writeInt(1, Pen.BALLPOINT_1)
                writer.writeInt(2, PenColor.BLACK)
                writer.writeDouble(3, 2)
                writer.writeFloat(4, 0)
                writer.subblock(5, () => {
                    writer.data.writeFloat32(100) // x
                    writer.data.writeFloat32(200) // y
                    writer.data.writeFloat32(1) // speed
                    writer.data.writeFloat32(0) // direction
                    writer.data.writeFloat32(0.625) // quarter-width
                    writer.data.writeFloat32(0.5) // pressure
                })
                writer.writeId(6, itemId)
            })
        })
        const original = writer.getBytes()
        const doc = RmDocument.parse(original)
        const [block] = doc.blocks
        expect(block?.type === 'sceneLineItem' ? block.line?.points[0]?.width : undefined).toBe(2.5)
        expect(doc.serialize()).toEqual(original)
    })

    for (const name of FIXTURE_NAMES) {
        test(name, () => {
            const original = fixture(name)
            const blocks = [...readBlocks(original)]
            const rewritten = writeBlocks(blocks)
            expect(rewritten.length).toBe(original.length)
            expect(Buffer.from(rewritten).equals(Buffer.from(original))).toBe(true)
        })
    }
})

describe('parse coverage', () => {
    test('xochitl-rewritten fixture parses fully (no RawBlock fallbacks)', () => {
        const blocks = [...readBlocks(fixture('ferrari-xochitl-rewritten-merge.rm'))]
        const raw = blocks.filter((b) => b.type === 'raw')
        expect(raw).toHaveLength(0)
        expect(blocks.filter((b) => b.type === 'sceneLineItem')).toHaveLength(5514)
        expect(blocks.filter((b) => b.type === 'authorIds')).toHaveLength(1)
    })

    test('unknown SceneInfo tag-6 field preserved in extraData (EVIDENCE E6)', () => {
        const blocks = [...readBlocks(fixture('ferrari-xochitl-rewritten-merge.rm'))]
        const sceneInfo = blocks.find((b) => b.type === 'sceneInfo')
        expect(sceneInfo).toBeDefined()
        expect(sceneInfo!.extraData.length).toBeGreaterThan(0)
        if (sceneInfo!.type === 'sceneInfo') {
            expect(sceneInfo!.paperSize).toEqual([1404, 1872])
        }
    })

    test('author renumbering evidence: merged single-table authors (E1/E2)', () => {
        const doc = RmDocument.parse(fixture('ferrari-xochitl-rewritten-merge.rm'))
        const authors = doc.authorTable()
        expect(authors.size).toBe(2)
        expect([...authors.values()].every((u) => /^[0-9a-f-]{36}$/.test(u))).toBe(true)
    })

    test('tombstones preserved through parse (E3)', () => {
        const blocks = [...readBlocks(fixture('ferrari-xochitl-rewritten-merge.rm'))]
        const tombstoned = blocks.filter(
            (b) => b.type === 'sceneLineItem' && b.deletedLength > 0,
        )
        expect(tombstoned).toHaveLength(5181)
    })
})

describe('RmDocument mutation', () => {
    function makeLine() {
        return {
            kind: 'line' as const,
            tool: Pen.MARKER_2,
            color: PenColor.BLACK,
            thicknessScale: 2,
            startingLength: 0,
            timestamp: crdtId(0, 1),
            moveId: null,
            points: [
                { x: 100, y: 100, speed: 0, direction: 0, width: 40, pressure: 128 },
                { x: 200, y: 200, speed: 4, direction: 32, width: 40, pressure: 128 },
            ],
        }
    }

    test('DEVICE-PINNED (E10): appendLine leftId is the file-order frontier, never toposort order', () => {
        // The xochitl-rewritten fixture contains tombstones with degenerate
        // (0,0) origins; toposort order diverges from append order there.
        // A toposort-derived leftId hard-hangs the device; must use the
        // file-order frontier instead.
        const doc = RmDocument.parse(fixture('ferrari-xochitl-rewritten-merge.rm'))
        let lastFileOrderItem: { part1: number; part2: number } | null = null
        for (const b of doc.blocks) {
            if (b.type === 'sceneLineItem') lastFileOrderItem = b.itemId
        }
        const block = doc.appendLine(makeLine(), {
            authorUuid: '746c6472-6177-0000-0000-000000000000',
        })
        expect(block.leftId).toEqual(lastFileOrderItem!)
        // timestamp is the item's own id
        expect(block.line!.timestamp).toEqual(block.itemId)
    })

    test('appendLine allocates per-author clock and registers UUID', () => {
        const doc = RmDocument.parse(fixture('ferrari-poc-append-history.rm'))
        const uuid = '746c6472-6177-0000-0000-000000000000'
        const before = doc.authorTable().size
        const block = doc.appendLine(makeLine(), { authorUuid: uuid })
        expect(block.itemId.part2).toBeGreaterThan(0)
        // resolves by UUID: appending again uses the same author index
        const block2 = doc.appendLine(makeLine(), { authorUuid: uuid })
        expect(block2.itemId.part1).toBe(block.itemId.part1)
        expect(block2.itemId.part2).toBe(block.itemId.part2 + 1)
        expect(block2.leftId).toEqual(block.itemId)
        void before
        // serializes and re-parses cleanly
        const reparsed = [...readBlocks(doc.serialize())]
        expect(reparsed.filter((b) => b.type === 'raw')).toHaveLength(0)
    })

    test('tombstone marks item deleted and survives round-trip', () => {
        const doc = RmDocument.parse(fixture('ferrari-poc-append-history.rm'))
        const live = doc.blocks.find(
            (b) => b.type === 'sceneLineItem' && b.deletedLength === 0 && b.line,
        )!
        if (live.type !== 'sceneLineItem') throw new Error('unreachable')
        expect(doc.tombstone(live.itemId)).toBe(true)
        const reparsed = RmDocument.parse(doc.serialize())
        const again = reparsed.blocks.find(
            (b) => b.type === 'sceneLineItem' && b.itemId.part1 === live.itemId.part1 && b.itemId.part2 === live.itemId.part2,
        )
        expect(again).toBeDefined()
        if (again?.type === 'sceneLineItem') {
            expect(again.deletedLength).toBeGreaterThan(0)
            expect(again.line).toBeNull()
        }
    })

    test('empty document serializes and re-parses', () => {
        const doc = RmDocument.empty('746c6472-6177-0000-0000-000000000000')
        doc.appendLine(makeLine(), { authorUuid: '746c6472-6177-0000-0000-000000000000' })
        const blocks = [...readBlocks(doc.serialize())]
        expect(blocks.filter((b) => b.type === 'raw')).toHaveLength(0)
        const tree = RmDocument.parse(doc.serialize()).tree()
        const lines = [...tree.walk()].filter(([, item]) => item?.kind === 'line')
        expect(lines).toHaveLength(1)
    })

    test('normalizeLayout sorts items by (author, clock) like xochitl (E1)', () => {
        const doc = RmDocument.parse(fixture('ferrari-poc-append-history.rm'))
        doc.normalizeLayout()
        const items = doc.blocks.filter((b) => b.type === 'sceneLineItem')
        for (let i = 1; i < items.length; i++) {
            const a = items[i - 1]!, b = items[i]!
            if (a.type !== 'sceneLineItem' || b.type !== 'sceneLineItem') continue
            const cmp = a.itemId.part1 - b.itemId.part1 || a.itemId.part2 - b.itemId.part2
            expect(cmp).toBeLessThan(0)
        }
        // still parses fine after normalization
        expect([...readBlocks(doc.serialize())].filter((b) => b.type === 'raw')).toHaveLength(0)
    })
})
