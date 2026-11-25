/**
 * Forward-compatibility pins for firmware-added content: image support adds
 * a new RootText paragraph style and possibly new fields, not new scene
 * blocks. Proves unknown style codes and firmware-new fields round-trip
 * (interpreted or RawBlock fallback), unknown block types reproduce
 * byte-exact, and crdtIdCompare matches xochitl's packed-u64 key.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { writeBlock } from '../src/blocks'
import {
    readBlocks,
    writeBlocks,
    TaggedBlockWriter,
    crdtId,
    crdtIdCompare,
    crdtIdKey,
    CrdtSequence,
    RmDocument,
    Pen,
    PenColor,
    lww,
    type RmBlock,
    type RootTextBlock,
    type RawBlock,
} from '../src/index'

const roundtrip = (bytes: Uint8Array) => writeBlocks([...readBlocks(bytes)])

function rootTextBlock(styleCode: number): RootTextBlock {
    const items = [
        {
            itemId: crdtId(1, 20),
            leftId: crdtId(0, 0),
            rightId: crdtId(0, 0),
            deletedLength: 0,
            value: 'Hello\n' as string | number,
        },
    ]
    return {
        type: 'rootText',
        version: { min: 1, current: 1 },
        extraData: new Uint8Array(0),
        blockId: crdtId(0, 0),
        textItems: items,
        text: {
            kind: 'text',
            items: new CrdtSequence(items.map((t) => ({ ...t, value: t.value ?? '' }))),
            styles: new Map([[crdtIdKey(crdtId(1, 20)), lww(crdtId(1, 21), styleCode)]]),
            posX: -468,
            posY: 234,
            width: 936,
        },
    }
}

describe('unknown paragraph styles (ImageBlock & friends)', () => {
    test('unknown style codes survive INTERPRETED round-trips byte-exact', () => {
        // 5 = known (checkbox era); 9/13/99 = codes this codec has never seen
        for (const code of [5, 9, 13, 99, 255]) {
            const bytes = writeBlocks([rootTextBlock(code)])
            const blocks = [...readBlocks(bytes)]
            const rt = blocks.find((b) => b.type === 'rootText') as RootTextBlock
            expect(rt).toBeDefined() // parsed, NOT a raw fallback
            const style = rt.text.styles.get(crdtIdKey(crdtId(1, 20)))
            expect(style?.value).toBe(code) // exact code retained
            expect(writeBlocks(blocks)).toEqual(bytes) // and re-emitted
            expect(roundtrip(roundtrip(bytes))).toEqual(bytes) // stable twice
        }
    })
})

describe('firmware-new fields fall back to RawBlock, byte-exact', () => {
    test('RootText with an unknown extra subblock inside a text item', () => {
        // Hand-build a RootText (0x07) whose text item carries an extra
        // subblock id 7 — the shape an image resource-id field would take.
        const w = new TaggedBlockWriter()
        w.writeHeader()
        w.block(0x07, 1, 1, () => {
            w.writeId(1, crdtId(0, 0))
            w.subblock(2, () => {
                w.subblock(1, () => {
                    w.subblock(1, () => {
                        w.data.writeVaruint(1)
                        w.subblock(0, () => {
                            w.writeId(2, crdtId(1, 20))
                            w.writeId(3, crdtId(0, 0))
                            w.writeId(4, crdtId(0, 0))
                            w.writeInt(5, 0)
                            w.writeString(6, 'X')
                            // firmware-new field our reader does not know:
                            w.subblock(7, () => w.data.writeVaruint(424242))
                        })
                    })
                })
                w.subblock(2, () => {
                    w.subblock(1, () => w.data.writeVaruint(0))
                })
            })
            w.subblock(3, () => {
                w.data.writeFloat64(-468)
                w.data.writeFloat64(234)
            })
            w.writeFloat(4, 936)
        })
        const bytes = w.getBytes()

        const blocks = [...readBlocks(bytes)]
        expect(blocks).toHaveLength(1)
        const raw = blocks[0] as RawBlock
        // strict reader refused to half-understand it -> verbatim fallback
        expect(raw.type).toBe('raw')
        expect(raw.blockType).toBe(0x07)
        expect(raw.parseError).toContain('leftover')
        expect(writeBlocks(blocks)).toEqual(bytes) // BYTE-EXACT out
    })

    test('completely unknown block type reproduces byte-exact, parsing continues after it', () => {
        // real first block (authorIds) taken from the ferrari fixture — no
        // hand-encoded wire bytes anywhere in this test
        const fixture = new Uint8Array(
            readFileSync(`${import.meta.dir}/../../../fixtures/ferrari-xochitl-rewritten-merge.rm`),
        )
        const realFirst = [...readBlocks(fixture)][0]!
        expect(realFirst.type).toBe('authorIds')

        const w = new TaggedBlockWriter()
        w.writeHeader()
        w.block(0x42, 0, 1, () => {
            w.data.writeBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))
        })
        writeBlock(w, realFirst)
        const bytes = w.getBytes()

        const blocks = [...readBlocks(bytes)]
        expect(blocks).toHaveLength(2)
        expect(blocks[0]!.type).toBe('raw')
        expect((blocks[0] as RawBlock).blockType).toBe(0x42)
        expect(blocks[1]!.type).toBe('authorIds') // parsing recovered after the unknown
        expect(writeBlocks(blocks)).toEqual(bytes)
    })

    test('REAL ferrari fixture with an unknown block spliced in round-trips', () => {
        const fixture = new Uint8Array(
            readFileSync(`${import.meta.dir}/../../../fixtures/ferrari-xochitl-rewritten-merge.rm`),
        )
        // header length measured from the writer itself, not assumed
        const hw = new TaggedBlockWriter()
        hw.writeHeader()
        const headerLen = hw.getBytes().length

        const w = new TaggedBlockWriter()
        w.writeHeader()
        w.block(0x66, 0, 2, () => w.data.writeBytes(new Uint8Array(33).fill(0xab)))
        const unknown = w.getBytes().slice(headerLen)
        const spliced = new Uint8Array(fixture.length + unknown.length)
        spliced.set(fixture.slice(0, headerLen), 0)
        spliced.set(unknown, headerLen)
        spliced.set(fixture.slice(headerLen), headerLen + unknown.length)

        const blocks = [...readBlocks(spliced)]
        expect(blocks.some((b) => b.type === 'raw' && (b as RawBlock).blockType === 0x66)).toBe(true)
        expect(writeBlocks(blocks)).toEqual(spliced)
    })
})

describe('file order is storage, walk order is render', () => {
    test('synthetic multi-author page: byte-exact, file-sorted, walk differs', () => {
        const authorA = '00000000-0000-4000-8000-000000000001'
        const authorB = '00000000-0000-4000-8000-000000000002'
        const fixture = RmDocument.empty(authorA)
        for (const [i, authorUuid] of [authorA, authorB, authorA, authorB].entries()) {
            fixture.appendLine({
                kind: 'line',
                color: i % 2 ? PenColor.RED : PenColor.BLUE,
                tool: Pen.FINELINER_2,
                thicknessScale: 1,
                startingLength: 0,
                timestamp: crdtId(0, 0),
                moveId: null,
                points: [{ x: i * 10, y: i * 20, pressure: 255, speed: 0, direction: 0, width: 16 }],
            }, { authorUuid })
        }
        const sorted = fixture.blocks.filter((b) => b.type === 'sceneLineItem')
            .sort((a, b) => crdtIdCompare(a.itemId, b.itemId))
        const bytes = writeBlocks(fixture.blocks.map((b) =>
            b.type === 'sceneLineItem' ? sorted.shift()! : b))
        const blocks = [...readBlocks(bytes)]
        expect(blocks.some((b) => b.type === 'raw')).toBe(false)
        expect(writeBlocks(blocks)).toEqual(bytes) // byte-exact round-trip

        const doc = RmDocument.parse(bytes)
        const items = doc.blocks.filter(
            (b) => 'itemId' in b && b.type !== 'sceneGroupItem',
        ) as unknown as { itemId: { part1: number; part2: number } }[]
        // xochitl lays the FILE out (author, clock) ascending...
        for (let i = 1; i < items.length; i++) {
            const a = items[i - 1]!.itemId
            const b = items[i]!.itemId
            expect(a.part1 < b.part1 || (a.part1 === b.part1 && a.part2 < b.part2)).toBe(true)
        }
        const authors = new Set(items.map((x) => x.itemId.part1))
        expect(authors.size).toBeGreaterThan(1) // genuinely multi-author

        // ...and the RENDER (walk) order genuinely differs from file order:
        // rendering doc.blocks would mis-stack this page (the layering bug).
        const fileOrder = (
            doc.blocks.filter(
                (b) => b.type === 'sceneLineItem' && (b as { deletedLength: number }).deletedLength === 0,
            ) as unknown as { itemId: { part1: number; part2: number } }[]
        ).map((b) => crdtIdKey(b.itemId as never))
        const walkOrder = [...doc.tree().walk()]
            .filter(([, item]) => (item as { kind: string }).kind === 'line')
            .map(([id]) => crdtIdKey(id))
        expect(walkOrder.length).toBe(fileOrder.length) // same set of live lines
        expect([...walkOrder].sort()).toEqual([...fileOrder].sort())
        expect(walkOrder).not.toEqual(fileOrder) // different ORDER
    })
})

describe('E18: comparator equals the packed-u64 key', () => {
    test('crdtIdCompare(a,b) sign == numeric compare of (author<<48)|clock', () => {
        const packed = (id: { part1: number; part2: number }) =>
            BigInt(id.part1) * 2n ** 48n + BigInt(id.part2)
        const ids = [
            crdtId(0, 0),
            crdtId(0, 1),
            crdtId(1, 0),
            crdtId(1, 2 ** 32), // clock beyond 32 bits
            crdtId(1, 2 ** 48 - 1), // clock at the 48-bit boundary
            crdtId(2, 1),
            crdtId(2, 9),
            crdtId(2, 10), // the lexicographic trap
            crdtId(65535, 0), // max author index
            crdtId(65535, 2 ** 48 - 1),
        ]
        for (const a of ids) {
            for (const b of ids) {
                const want = packed(a) < packed(b) ? -1 : packed(a) > packed(b) ? 1 : 0
                expect(Math.sign(crdtIdCompare(a, b))).toBe(want)
            }
        }
    })
})
