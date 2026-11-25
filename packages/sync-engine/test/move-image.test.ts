/**
 * move-image op: device-native move pattern (tombstone + re-append, the
 * same thing xochitl does for its own moves — never in-place mutation).
 */

import { describe, expect, test } from 'bun:test'
import { applyOps } from '../src/apply-ops'
import { RefResolver } from '../src/refs'
import {
    RmDocument,
    readBlocks,
    writeBlocks,
    crdtId,
    crdtIdKey,
    lww,
    uuidToBytesLE,
    bytesToUuidLE,
    type SceneImageInfoBlock,
    type SceneImageItemBlock,
} from '@weft/rm-format'

const AUTHOR = 'c8050a7c-0000-4000-a000-000000000001'
const ASSET = '5f80365d-972e-415d-8030-6f4dee13ac92'

function imageDoc(): { doc: RmDocument; itemRef: { authorUuid: string; clock: number } } {
    const doc = RmDocument.empty(AUTHOR)
    doc.blocks.push({
        type: 'sceneImageInfo',
        version: { min: 3, current: 3 },
        extraData: new Uint8Array(0),
        images: [
            {
                uuid: ASSET,
                filename: lww(crdtId(1, 50), `${ASSET}.png`),
                flags: lww(crdtId(1, 51), new Uint8Array([17, 0])),
            },
        ],
    } satisfies SceneImageInfoBlock)
    const block = doc.appendImage(
        {
            kind: 'image',
            uuid: lww(crdtId(1, 52), uuidToBytesLE(ASSET)),
            timestamp: crdtId(0, 0),
            vertices: [-200, 300, 0, 0, 200, 300, 1, 0, 200, 600, 1, 1, -200, 600, 0, 1],
            indices: [0, 1, 2, 2, 3, 0],
            filename: null,
        },
        { authorUuid: AUTHOR },
    )
    const ref = new RefResolver(doc).toRef(block.itemId)!
    return { doc, itemRef: ref }
}

describe('move-image', () => {
    test('tombstones the old item and re-appends with new placement', () => {
        const { doc, itemRef } = imageDoc()
        const before = RmDocument.parse(doc.serialize())
        const oldId = new RefResolver(before).toId(itemRef)!

        const newVertices = [100, 900, 0, 0, 500, 900, 1, 0, 500, 1200, 1, 1, 100, 1200, 0, 1]
        applyOps(doc, { shapes: [] }, [{ type: 'move-image', item: itemRef, vertices: newVertices }], {
            authorUuid: AUTHOR,
        })

        const items = doc.blocks.filter(
            (b) => b.type === 'sceneImageItem',
        ) as SceneImageItemBlock[]
        expect(items).toHaveLength(2)
        const dead = items.find((b) => b.deletedLength > 0)!
        const live = items.find((b) => b.deletedLength === 0)!
        expect(crdtIdKey(dead.itemId)).toBe(crdtIdKey(oldId))
        expect(live.image!.vertices).toEqual(newVertices)
        // asset identity preserved across the move
        expect(bytesToUuidLE(live.image!.uuid.value)).toBe(ASSET)
        // new item chains at the file-order frontier
        expect(crdtIdKey(live.leftId)).toBe(crdtIdKey(dead.itemId))
        // byte-exact after the round trip
        const bytes = doc.serialize()
        expect(writeBlocks([...readBlocks(bytes)])).toEqual(bytes)
    })

    test('idempotent re-apply on fresher bytes (409 rebase semantics)', () => {
        const { doc, itemRef } = imageDoc()
        const ops = [
            {
                type: 'move-image' as const,
                item: itemRef,
                vertices: [0, 0, 0, 0, 10, 0, 1, 0, 10, 10, 1, 1, 0, 10, 0, 1],
            },
        ]
        const a = RmDocument.parse(doc.serialize())
        const b = RmDocument.parse(doc.serialize())
        applyOps(a, { shapes: [] }, ops, { authorUuid: AUTHOR })
        applyOps(b, { shapes: [] }, ops, { authorUuid: AUTHOR })
        expect(a.serialize()).toEqual(b.serialize()) // deterministic
    })

    test('unknown ref is a no-op (item erased remotely before our move landed)', () => {
        const { doc } = imageDoc()
        const before = doc.serialize()
        applyOps(
            doc,
            { shapes: [] },
            [
                {
                    type: 'move-image',
                    item: { authorUuid: AUTHOR, clock: 9999 },
                    vertices: [0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 1],
                },
            ],
            { authorUuid: AUTHOR },
        )
        expect(doc.serialize()).toEqual(before)
    })
})
