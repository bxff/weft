/**
 * applyOps unit coverage for the edit-root-text LocalOp (device typed-text
 * edits; snapshot fallback like layer ops).
 */
import { expect, test } from 'bun:test'
import { RmDocument } from '@weft/rm-format'
import { applyOps } from '../src/apply-ops'
import type { OverlayDocument } from '../src/types'

const AUTHOR = 'c8050a7c-9999-4999-a999-000000000001'

// ----- device typed-text edits (the snapshot-fallback text op) -----
import {
    linearizeRootText as _linearize,
    rootTextCharPositions as _positions,
    crdtIdKey as _key,
    ParagraphStyle as _PS,
} from '@weft/rm-format'

test('edit-root-text: create + insert + style, snapshot fallback flagged', () => {
    const doc = RmDocument.empty(AUTHOR)
    const overlay: OverlayDocument = { shapes: [] }
    const r1 = applyOps(
        doc,
        overlay,
        [
            {
                type: 'edit-root-text',
                create: {},
                inserts: [{ afterKey: null, text: 'Title\nBody text' }],
            },
        ],
        { authorUuid: AUTHOR },
    )
    expect(r1.complete).toBe(false) // must publish a snapshot
    const rt = doc.tree().rootText!
    expect(
        _linearize(rt)
            .map((p) => p.spans.map((s) => s.text).join(''))
            .join('\n'),
    ).toBe('Title\nBody text')

    // style the second paragraph via its opening newline
    const nl = _positions(rt).find((c) => c.offset === -1)!
    const r2 = applyOps(
        doc,
        overlay,
        [{ type: 'edit-root-text', styles: [[_key(nl.id), _PS.HEADING]] }],
        { authorUuid: AUTHOR },
    )
    expect(r2.complete).toBe(false)
    expect(_linearize(doc.tree().rootText!)[1]!.style).toBe(_PS.HEADING)
})

test('edit-root-text: delete tombstones through the run-splitting path', () => {
    const doc = RmDocument.empty(AUTHOR)
    const overlay: OverlayDocument = { shapes: [] }
    applyOps(
        doc,
        overlay,
        [{ type: 'edit-root-text', create: {}, inserts: [{ afterKey: null, text: 'ABCDE' }] }],
        { authorUuid: AUTHOR },
    )
    const chars = _positions(doc.tree().rootText!)
    applyOps(
        doc,
        overlay,
        [{ type: 'edit-root-text', deleteKeys: [_key(chars[2]!.id)] }],
        { authorUuid: AUTHOR },
    )
    // roundtrip through real bytes: the wire shape must hold
    const back = RmDocument.parse(doc.serialize())
    expect(
        _linearize(back.tree().rootText!)
            .map((p) => p.spans.map((s) => s.text).join(''))
            .join(''),
    ).toBe('ABDE')
})
