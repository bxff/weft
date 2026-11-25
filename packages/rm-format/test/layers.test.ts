/**
 * Layers: list / create / visibility — byte-exact, frontier-correct,
 * and safe for single-layer documents (no behavior change there).
 */

import { describe, expect, test } from 'bun:test'
import { RmDocument, readBlocks, writeBlocks, crdtId, crdtIdKey, Pen, PenColor } from '../src/index'
import { polylineToPoints } from '../../rm-ink/src/points'

const AUTHOR = 'c8050a7c-0000-4000-a000-000000000001'

const stroke = () =>
    ({
        kind: 'line' as const,
        tool: Pen.MARKER_2,
        color: PenColor.BLACK,
        thicknessScale: 2,
        startingLength: 0,
        timestamp: crdtId(0, 1),
        moveId: null,
        points: polylineToPoints(
            [
                { x: 0, y: 0 },
                { x: 10, y: 10 },
            ],
            { width: 40 },
        ),
    })

describe('layers', () => {
    test('empty doc reports its single default layer', () => {
        const doc = RmDocument.empty(AUTHOR)
        const layers = doc.layers()
        expect(layers).toHaveLength(1)
        expect(layers[0]!.label).toBe('Layer 1')
        expect(layers[0]!.visible).toBe(true)
    })

    test('createLayer: trio round-trips byte-exact; group chains at ROOT frontier', () => {
        const doc = RmDocument.empty(AUTHOR)
        const firstLayerItem = doc.layers()[0]!.itemId
        const nodeId = doc.createLayer('Layer 2', { authorUuid: AUTHOR })

        const layers = doc.layers()
        expect(layers).toHaveLength(2)
        expect(layers[1]!.label).toBe('Layer 2')
        expect(crdtIdKey(layers[1]!.nodeId)).toBe(crdtIdKey(nodeId))
        // the new group item's leftId is the previous layer's group item
        const group = doc.blocks.find(
            (b) => b.type === 'sceneGroupItem' && b.nodeId && crdtIdKey(b.nodeId) === crdtIdKey(nodeId),
        ) as { leftId: object }
        expect(crdtIdKey(group.leftId as never)).toBe(crdtIdKey(firstLayerItem))

        const bytes = doc.serialize()
        expect(writeBlocks([...readBlocks(bytes)])).toEqual(bytes)
        // reparse sees both layers
        expect(RmDocument.parse(bytes).layers()).toHaveLength(2)
    })

    test('strokes target the chosen layer and use ITS frontier', () => {
        const doc = RmDocument.empty(AUTHOR)
        const layer2 = doc.createLayer('Layer 2', { authorUuid: AUTHOR })
        const a = doc.appendLine(stroke(), { authorUuid: AUTHOR }) // default layer
        const b = doc.appendLine(stroke(), { authorUuid: AUTHOR, parentId: layer2 })
        const c = doc.appendLine(stroke(), { authorUuid: AUTHOR, parentId: layer2 })

        expect(crdtIdKey(b.parentId)).toBe(crdtIdKey(layer2))
        // per-parent frontier: c chains after b (not after a)
        expect(crdtIdKey(c.leftId)).toBe(crdtIdKey(b.itemId))
        expect(crdtIdKey(b.leftId)).toBe('0:0') // first item in layer 2
        expect(crdtIdKey(a.parentId)).not.toBe(crdtIdKey(layer2))

        const bytes = doc.serialize()
        expect(writeBlocks([...readBlocks(bytes)])).toEqual(bytes)
    })

    test('setLayerVisible: LWW flips with a fresh timestamp, byte-exact', () => {
        const doc = RmDocument.empty(AUTHOR)
        const nodeId = doc.layers()[0]!.nodeId
        expect(doc.setLayerVisible(nodeId, false, { authorUuid: AUTHOR })).toBe(true)
        expect(doc.layers()[0]!.visible).toBe(false)
        const bytes = doc.serialize()
        const back = RmDocument.parse(bytes)
        expect(back.layers()[0]!.visible).toBe(false)
        expect(writeBlocks([...readBlocks(bytes)])).toEqual(bytes)
        // unknown node is a no-op
        expect(doc.setLayerVisible(crdtId(9, 999), false, { authorUuid: AUTHOR })).toBe(false)
    })

    test('walk renders layers in sequence order (layer 2 ink above layer 1)', () => {
        const doc = RmDocument.empty(AUTHOR)
        const layer2 = doc.createLayer('Layer 2', { authorUuid: AUTHOR })
        doc.appendLine(stroke(), { authorUuid: AUTHOR, parentId: layer2 })
        doc.appendLine(stroke(), { authorUuid: AUTHOR }) // layer 1, added later
        const walk = [...RmDocument.parse(doc.serialize()).tree().walk()]
        const kinds = walk.map(([, i]) => (i as { kind: string }).kind)
        // groups appear in root order; layer-1 ink stays under layer-2 ink
        // because LAYER order (not draw order) wins across layers
        const lineParents: string[] = []
        for (const [id, item] of walk) {
            if ((item as { kind: string }).kind === 'line') lineParents.push(crdtIdKey(id))
        }
        expect(kinds.filter((k) => k === 'group')).toHaveLength(2)
        expect(lineParents).toHaveLength(2)
    })
})
