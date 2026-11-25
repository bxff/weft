/**
 * Embedded image blocks (firmware 3.27+):
 *  - 0x0E SceneImageInfo: uuid -> asset filename registry
 *  - 0x0F SceneImageItem: placement quad in the scene tree (item type 7)
 *
 * Pins: byte-exact round-trips, tree filename resolution, z-order
 * participation, and the frontier rule covering image items.
 */

import { describe, expect, test } from 'bun:test'
import {
    RmDocument,
    readBlocks,
    writeBlocks,
    crdtId,
    crdtIdKey,
    lww,
    uuidToBytesLE,
    Pen,
    PenColor,
    isImage,
    isLine,
    type SceneImageInfoBlock,
    type SceneImageItemBlock,
    type RmBlock,
} from '../src/index'

const AUTHOR = 'f73f497f-0000-4000-a000-000000000000'
const ASSET_UUID = '5f80365d-972e-415d-8030-6f4dee13ac92'
const QUAD_INDICES = [0, 1, 2, 2, 3, 0]

function line(x: number) {
    return {
        kind: 'line' as const,
        tool: Pen.BALLPOINT_2,
        color: PenColor.BLACK,
        thicknessScale: 1,
        startingLength: 0,
        timestamp: crdtId(0, 1),
        moveId: null,
        points: [
            { x, y: 100, speed: 0, direction: 0, width: 8, pressure: 100 },
            { x, y: 200, speed: 0, direction: 0, width: 8, pressure: 100 },
        ],
    }
}

/** Doc with [line, image, line] under the default layer. */
function docWithImage(): { doc: RmDocument; itemId: ReturnType<typeof crdtId> } {
    const doc = RmDocument.empty(AUTHOR)
    doc.appendLine(line(100), { authorUuid: AUTHOR })

    const layer = doc.defaultLayerId()!
    const itemId = crdtId(1, 100)
    const imageItem: SceneImageItemBlock = {
        type: 'sceneImageItem',
        version: { min: 2, current: 2 },
        extraData: new Uint8Array(0),
        parentId: layer,
        itemId,
        leftId: doc.appendFrontier(layer),
        rightId: crdtId(0, 0),
        deletedLength: 0,
        extraValueData: new Uint8Array(0),
        image: {
            kind: 'image',
            uuid: lww(crdtId(1, 101), uuidToBytesLE(ASSET_UUID)),
            timestamp: crdtId(1, 102),
            // TL TR BR BL corners x (x, y, u, v)
            vertices: [
                -200, 300, 0, 0,
                200, 300, 1, 0,
                200, 600, 1, 1,
                -200, 600, 0, 1,
            ],
            indices: [...QUAD_INDICES],
            filename: null,
        },
    }
    const imageInfo: SceneImageInfoBlock = {
        type: 'sceneImageInfo',
        version: { min: 3, current: 3 },
        extraData: new Uint8Array(0),
        images: [
            {
                uuid: ASSET_UUID,
                filename: lww(crdtId(1, 103), `${ASSET_UUID}.png`),
                flags: lww(crdtId(1, 104), new Uint8Array([17, 0])),
            },
        ],
    }
    doc.blocks.push(imageInfo, imageItem)
    doc.appendLine(line(300), { authorUuid: AUTHOR })
    return { doc, itemId }
}

describe('image blocks (0x0E / 0x0F)', () => {
    test('serialize -> parse -> serialize is byte-exact, fully interpreted', () => {
        const { doc } = docWithImage()
        const bytes = doc.serialize()
        const blocks = [...readBlocks(bytes)]
        expect(blocks.some((b) => b.type === 'raw')).toBe(false) // interpreted, no fallback
        expect(writeBlocks(blocks)).toEqual(bytes)

        const info = blocks.find((b) => b.type === 'sceneImageInfo') as SceneImageInfoBlock
        expect(info.images[0]!.uuid).toBe(ASSET_UUID)
        expect(info.images[0]!.filename.value).toBe(`${ASSET_UUID}.png`)
        expect([...info.images[0]!.flags.value]).toEqual([17, 0])

        const item = blocks.find((b) => b.type === 'sceneImageItem') as SceneImageItemBlock
        expect(item.image!.vertices).toHaveLength(16)
        expect(item.image!.vertices[4]).toBe(200) // float32-clean values survive
        expect(item.image!.indices).toEqual(QUAD_INDICES)
    })

    test('tree resolves the asset filename and keeps the image in z-order', () => {
        const { doc } = docWithImage()
        const reparsed = RmDocument.parse(doc.serialize())
        const source = reparsed.blocks.find((b) => b.type === 'sceneImageItem') as SceneImageItemBlock
        const original = structuredClone(source)
        const walk = [...reparsed.tree().walk()].filter(([, i]) => isLine(i) || isImage(i))
        // edit order: line(100), image, line(300) — image stacked BETWEEN
        expect(walk.map(([, i]) => i.kind)).toEqual(['line', 'image', 'line'])
        const image = walk[1]![1]
        if (!isImage(image)) throw new Error('expected image')
        expect(image.filename).toBe(`${ASSET_UUID}.png`)
        expect(source).toEqual(original)

        const registry = reparsed.blocks.find((b) => b.type === 'sceneImageInfo') as SceneImageInfoBlock
        registry.images[0]!.filename.value = 'renamed.png'
        const renamed = [...reparsed.tree().walk()].map(([, item]) => item).find(isImage)
        expect(renamed?.filename).toBe('renamed.png')
        expect(image.filename).toBe(`${ASSET_UUID}.png`)
        expect(source).toEqual(original)

        registry.images.length = 0
        const missing = [...reparsed.tree().walk()].map(([, item]) => item).find(isImage)
        expect(missing?.filename).toBeNull()
        expect(source).toEqual(original)
    })

    test('E10: appendFrontier includes image items (next stroke chains AFTER the image)', () => {
        const { doc, itemId } = docWithImage()
        // the second appendLine ran after the image was pushed: its leftId
        // must be the IMAGE item, not the first line
        const lines = doc.blocks.filter(
            (b) => b.type === 'sceneLineItem',
        ) as { itemId: object; leftId: object }[]
        expect(crdtIdKey(lines[1]!.leftId as never)).toBe(crdtIdKey(itemId))
    })

    test('tombstoned image item (no value subblock) round-trips', () => {
        const { doc } = docWithImage()
        const item = doc.blocks.find((b) => b.type === 'sceneImageItem') as SceneImageItemBlock
        item.image = null
        item.deletedLength = 1
        const bytes = doc.serialize()
        const blocks = [...readBlocks(bytes)]
        const back = blocks.find((b) => b.type === 'sceneImageItem') as SceneImageItemBlock
        expect(back.image).toBeNull()
        expect(back.deletedLength).toBe(1)
        expect(writeBlocks(blocks)).toEqual(bytes)
    })

    test('image value with EXTRA future bytes still falls back safely at block level', () => {
        const { doc } = docWithImage()
        const item = doc.blocks.find((b) => b.type === 'sceneImageItem') as SceneImageItemBlock
        item.extraValueData = new Uint8Array([0x99, 0x01, 0x02]) // firmware-future field
        const bytes = doc.serialize()
        const blocks = [...readBlocks(bytes)]
        // trailing value bytes are the same contract as line items: retained
        const back = blocks.find((b) => b.type === 'sceneImageItem') as SceneImageItemBlock
        expect([...back.extraValueData]).toEqual([0x99, 0x01, 0x02])
        expect(writeBlocks(blocks)).toEqual(bytes)
    })
})

// keep RmBlock import used for typing clarity in fixtures above
export type _Check = RmBlock

describe('move-image building blocks', () => {
    test('appendImage: frontier leftId, timestamp = own id, byte-exact', () => {
        const { doc } = docWithImage()
        const frontier = doc.appendFrontier(doc.defaultLayerId()!)
        const block = doc.appendImage(
            {
                kind: 'image',
                uuid: lww(crdtId(1, 200), uuidToBytesLE(ASSET_UUID)),
                timestamp: crdtId(0, 0), // overwritten by appendImage
                vertices: [0, 0, 0, 0, 10, 0, 1, 0, 10, 10, 1, 1, 0, 10, 0, 1],
                indices: [0, 1, 2, 2, 3, 0],
                filename: null,
            },
            { authorUuid: AUTHOR },
        )
        expect(crdtIdKey(block.leftId)).toBe(crdtIdKey(frontier))
        expect(crdtIdKey(block.image!.timestamp)).toBe(crdtIdKey(block.itemId))
        const bytes = doc.serialize()
        expect(writeBlocks([...readBlocks(bytes)])).toEqual(bytes)
    })

    test('tombstone covers image items', () => {
        const { doc, itemId } = docWithImage()
        expect(doc.tombstone(itemId)).toBe(true)
        const bytes = doc.serialize()
        const back = [...readBlocks(bytes)].find(
            (b) => b.type === 'sceneImageItem',
        ) as SceneImageItemBlock
        expect(back.deletedLength).toBe(1)
        expect(back.image).toBeNull()
        expect(writeBlocks([...readBlocks(bytes)])).toEqual(bytes)
    })
})
