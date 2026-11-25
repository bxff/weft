/**
 * Z-order integrator core: real-adjacent origins from the current sequence
 * view, correct resulting render order under the concurrent tie-break,
 * byte-exact round-trips.
 */

import { describe, expect, test } from 'bun:test'
import { RmDocument, crdtId, crdtIdKey, Pen, PenColor, isLine } from '../src/index'
import { polylineToPoints } from '../../rm-ink/src/points'

const AUTHOR = 'c8050a7c-0000-4000-a000-000000000001'

const line = (x: number) => ({
    kind: 'line' as const,
    tool: Pen.MARKER_2,
    color: PenColor.BLACK,
    thicknessScale: 2,
    startingLength: 0,
    timestamp: crdtId(0, 1),
    moveId: null,
    points: polylineToPoints(
        [
            { x, y: 0 },
            { x, y: 100 },
        ],
        { width: 40 },
    ),
})

function docABC() {
    const doc = RmDocument.empty(AUTHOR)
    const a = doc.appendLine(line(100), { authorUuid: AUTHOR })
    const b = doc.appendLine(line(200), { authorUuid: AUTHOR })
    const c = doc.appendLine(line(300), { authorUuid: AUTHOR })
    return { doc, a, b, c }
}

const walkXs = (doc: RmDocument) =>
    [...doc.tree().walk()]
        .filter(([, i]) => isLine(i))
        .map(([, i]) => (i as { points: { x: number }[] }).points[0]!.x)

describe('originsAt / insertLineAt', () => {
    test('origins are the REAL adjacent ids of the render order', () => {
        const { doc, a, b, c } = docABC()
        const layer = doc.defaultLayerId()!
        expect(crdtIdKey(doc.originsAt(layer, 0).leftId)).toBe('0:0')
        expect(crdtIdKey(doc.originsAt(layer, 0).rightId)).toBe(crdtIdKey(a.itemId))
        expect(crdtIdKey(doc.originsAt(layer, 2).leftId)).toBe(crdtIdKey(b.itemId))
        expect(crdtIdKey(doc.originsAt(layer, 2).rightId)).toBe(crdtIdKey(c.itemId))
        // end == frontier append semantics
        expect(crdtIdKey(doc.originsAt(layer, 99).leftId)).toBe(crdtIdKey(c.itemId))
        expect(crdtIdKey(doc.originsAt(layer, 99).rightId)).toBe('0:0')
    })

    test('mid-sequence insert renders at the chosen depth after reparse', () => {
        const { doc } = docABC()
        doc.insertLineAt(line(150), { authorUuid: AUTHOR, beforeIndex: 1 })
        expect(walkXs(doc)).toEqual([100, 150, 200, 300])
        // survives serialize -> reparse (and the xochitl-style layout sort)
        doc.normalizeLayout()
        const back = RmDocument.parse(doc.serialize())
        expect(walkXs(back)).toEqual([100, 150, 200, 300])
        expect(back.serialize()).toEqual(doc.serialize())
    })

    test('bottom insert (index 0) goes under everything', () => {
        const { doc } = docABC()
        doc.insertLineAt(line(50), { authorUuid: AUTHOR, beforeIndex: 0 })
        expect(walkXs(RmDocument.parse(doc.serialize()))).toEqual([50, 100, 200, 300])
    })

    test('sequence of two inserts at the same index stays deterministic', () => {
        const { doc } = docABC()
        doc.insertLineAt(line(140), { authorUuid: AUTHOR, beforeIndex: 1 })
        doc.insertLineAt(line(160), { authorUuid: AUTHOR, beforeIndex: 2 })
        expect(walkXs(RmDocument.parse(doc.serialize()))).toEqual([100, 140, 160, 200, 300])
    })
})
