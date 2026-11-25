/**
 * xochitl appends a new authorIds block when an author joins a page instead
 * of rewriting the first one, so a file can carry several. Reading only the
 * first block makes later authors' strokes resolve to a null ref and vanish.
 */

import { expect, test } from 'bun:test'
import { RmDocument, Pen, PenColor } from '../src/index'

const A1 = 'aaaaaaaa-0000-4000-a000-000000000001'
const A2 = 'bbbbbbbb-0000-4000-a000-000000000002'

function withSecondAuthorBlock(): RmDocument {
    const doc = RmDocument.empty(A1)
    doc.appendLine(
        {
            kind: 'line',
            tool: Pen.BALLPOINT_2,
            color: PenColor.BLACK,
            thicknessScale: 2,
            startingLength: 0,
            timestamp: { part1: 0, part2: 1 },
            moveId: null,
            points: [
                { x: 0, y: 0, speed: 0, direction: 0, width: 8, pressure: 128 },
                { x: 10, y: 10, speed: 4, direction: 32, width: 8, pressure: 128 },
            ],
        },
        { authorUuid: A1 },
    )
    // simulate xochitl: a SECOND authorIds block appended later for a new author
    doc.blocks.push({
        type: 'authorIds',
        version: { min: 0, current: 0 },
        extraData: new Uint8Array(0),
        authors: new Map([[2, A2]]),
    } as never)
    return doc
}

test('authorTable merges every authorIds block (later blocks win per index)', () => {
    const doc = withSecondAuthorBlock()
    const table = doc.authorTable()
    expect(table.get(1)).toBe(A1)
    expect(table.get(2)).toBe(A2)
})

test('a later-block author round-trips through serialize/parse', () => {
    const doc = withSecondAuthorBlock()
    const back = RmDocument.parse(doc.serialize())
    expect(back.authorTable().get(2)).toBe(A2)
})

test('resolveAuthor never hands out an index a later block already owns', () => {
    const doc = withSecondAuthorBlock()
    const idx = doc.resolveAuthor('cccccccc-0000-4000-a000-000000000003')
    expect(idx).not.toBe(1)
    expect(idx).not.toBe(2)
    // and resolving an author registered only in the LATER block finds it
    expect(doc.resolveAuthor(A2)).toBe(2)
})
