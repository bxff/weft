import { expect, test } from 'bun:test'
import { BlockType, readBlocks, writeBlocks } from '../src/blocks'
import { crdtId } from '../src/crdt-id'
import { TaggedBlockWriter } from '../src/tagged-block'

function opaqueItem(type: number, value: number[] | null): Uint8Array {
    const writer = new TaggedBlockWriter()
    writer.writeHeader()
    writer.block(type, 0, 0, () => {
        writer.writeId(1, crdtId(0, 11))
        writer.writeId(2, crdtId(1, 42))
        writer.writeId(3, crdtId(0, 0))
        writer.writeId(4, crdtId(0, 0))
        writer.writeInt(5, 1)
        if (value !== null) {
            writer.subblock(6, () => writer.data.writeBytes(Uint8Array.from(value)))
        }
    })
    return writer.getBytes()
}

for (const type of [BlockType.SceneTextItem, BlockType.SceneTombstoneItem]) {
    for (const value of [null, [17], [17, 99, 0, 255], [0, 99]]) {
        test(`opaque item ${type} preserves the entire value ${JSON.stringify(value)}`, () => {
            // Construct the wire bytes independently of the scene-item writer.
            const bytes = opaqueItem(type, value)
            const blocks = [...readBlocks(bytes)]
            expect(blocks).toHaveLength(1)
            expect(blocks[0]!.type).toBe('sceneTombstoneItem')
            if (blocks[0]!.type !== 'sceneTombstoneItem') throw new Error('unexpected block')
            expect(blocks[0]!.extraValueData).toEqual(Uint8Array.from(value ?? []))
            const encoded = writeBlocks(blocks)
            expect(encoded).toEqual(bytes)
            expect(writeBlocks([...readBlocks(encoded)])).toEqual(bytes)
        })
    }
    test(`opaque item ${type} keeps an empty value subblock as raw data`, () => {
        const bytes = opaqueItem(type, [])
        const blocks = [...readBlocks(bytes)]
        expect(blocks[0]!.type).toBe('raw')
        expect(writeBlocks(blocks)).toEqual(bytes)
    })
}
