/**
 * Root-text mutations: web-authored typed text must roundtrip through the
 * real serializer, tombstone (never remove) on delete, keep implicit ids
 * stable across run splits, and merge with tablet-authored edits.
 */
import { describe, expect, test } from 'bun:test'
import {
    RmDocument,
    createRootText,
    insertText,
    deleteText,
    setParagraphStyle,
    linearizeRootText,
    mergeRootTextInto,
    rootTextCharPositions,
    crdtId,
    crdtIdKey,
    ParagraphStyle,
    encodeStyleExtra,
} from '../src/index'

const WEB = 'c8050a7c-9999-4999-a999-000000000001'
const TABLET = 'aaaa0000-0000-4000-a000-000000000001'

function textOf(doc: RmDocument): string {
    const rt = doc.tree().rootText
    if (!rt) return ''
    return linearizeRootText(rt)
        .map((p) => p.spans.map((s) => s.text).join(''))
        .join('\n')
}

function roundtrip(doc: RmDocument): RmDocument {
    return RmDocument.parse(doc.serialize())
}

test('create + insert + roundtrip: a page grows a text column from nothing', () => {
    const doc = RmDocument.empty(WEB)
    createRootText(doc)
    insertText(doc, null, 'Hello device\nSecond line', { authorUuid: WEB })
    const back = roundtrip(doc)
    expect(textOf(back)).toBe('Hello device\nSecond line')
    const rt = back.tree().rootText!
    expect(rt.posX).toBe(-468)
    expect(rt.width).toBe(936)
})

test('insert after a specific char lands mid-text and survives roundtrip', () => {
    const doc = RmDocument.empty(WEB)
    createRootText(doc)
    const first = insertText(doc, null, 'AB', { authorUuid: WEB })
    // after 'A' (first id) insert 'X' -> AXB
    insertText(doc, first, 'X', { authorUuid: WEB })
    expect(textOf(roundtrip(doc))).toBe('AXB')
})

test('delete tombstones (ids preserved for anchors), splits runs correctly', () => {
    const doc = RmDocument.empty(WEB)
    createRootText(doc)
    const first = insertText(doc, null, 'ABCDE', { authorUuid: WEB })
    // delete C and D (implicit ids first+2, first+3)
    deleteText(doc, [crdtId(first.part1, first.part2 + 2), crdtId(first.part1, first.part2 + 3)])
    const back = roundtrip(doc)
    expect(textOf(back)).toBe('ABE')
    // the tombstoned ids still exist in the sequence (anchor targets)
    const pos = rootTextCharPositions(back.tree().rootText!)
    const key = crdtIdKey(crdtId(first.part1, first.part2 + 2))
    const tomb = pos.find((p) => crdtIdKey(p.id) === key)
    expect(tomb?.deleted).toBe(true)
})

test('paragraph style set by the web wins as LWW and roundtrips', () => {
    const doc = RmDocument.empty(WEB)
    createRootText(doc)
    const first = insertText(doc, null, 'Title\nBody', { authorUuid: WEB })
    // the '\n' anchor is the char after 'Title' (implicit id first+5)
    const nl = crdtId(first.part1, first.part2 + 5)
    setParagraphStyle(doc, nl, ParagraphStyle.HEADING, { authorUuid: WEB })
    const paras = linearizeRootText(roundtrip(doc).tree().rootText!)
    expect(paras[1]!.style).toBe(ParagraphStyle.HEADING)
})

test('web and tablet edits merge: concurrent inserts both survive', () => {
    // tablet writes first
    const doc = RmDocument.empty(TABLET)
    createRootText(doc)
    insertText(doc, null, 'tablet text', { authorUuid: TABLET })
    // web edits the SAME doc under its own author id
    const bytes = doc.serialize()
    const web = RmDocument.parse(bytes)
    const ids = rootTextCharPositions(web.tree().rootText!)
    const last = ids[ids.length - 1]!.id
    insertText(web, last, ' plus web', { authorUuid: WEB })
    const back = roundtrip(web)
    expect(textOf(back)).toBe('tablet text plus web')
    // two distinct author slots exist
    expect(new Set(back.authorTable().values()).size).toBeGreaterThanOrEqual(2)
})

test('deleting across a format code keeps the code as its own tombstone', () => {
    const doc = RmDocument.empty(WEB)
    createRootText(doc)
    const a = insertText(doc, null, 'ab', { authorUuid: WEB })
    // bold-on code after 'ab', then more text
    const boldId = crdtId(a.part1, a.part2 + 2)
    const block = doc.blocks.find((b) => b.type === 'rootText')! as never as {
        textItems: { itemId: unknown; leftId: unknown; rightId: unknown; deletedLength: number; value: unknown }[]
    }
    block.textItems.push({
        itemId: boldId,
        leftId: crdtId(a.part1, a.part2 + 1),
        rightId: crdtId(0, 0),
        deletedLength: 0,
        value: 1,
    })
    insertText(doc, boldId, 'cd', { authorUuid: WEB })
    expect(textOf(roundtrip(doc))).toBe('abcd')
    // delete 'b' and 'c' (spanning the code): text shrinks, code survives
    deleteText(doc, [
        crdtId(a.part1, a.part2 + 1),
        crdtId(a.part1, a.part2 + 3),
    ])
    const back = roundtrip(doc)
    expect(textOf(back)).toBe('ad')
})

describe('inline format codes (bold/italic)', () => {
    // pull in the new API without touching the header import block
    const {
        insertFormatCode,
        planFormatEdits,
    } = require('../src/index') as typeof import('../src/index')

    function spansOf(doc: RmDocument) {
        const rt = doc.tree().rootText!
        return linearizeRootText(rt).map((p) =>
            p.spans.map((s) => ({ text: s.text, bold: s.bold, italic: s.italic })),
        )
    }

    function applyPlan(doc: RmDocument, target: { bold: boolean; italic: boolean }[]) {
        const plan = planFormatEdits(doc.tree().rootText!, target)!
        expect(plan).not.toBeNull()
        if (plan.deleteIds.length) deleteText(doc, plan.deleteIds)
        for (const ins of plan.inserts) {
            let after = ins.afterId
            for (const code of ins.codes) {
                after = insertFormatCode(doc, after, code, { authorUuid: WEB })
            }
        }
    }

    const T = (s: string, marks: string) =>
        [...s].map((_, i) => ({ bold: marks[i] === 'b' || marks[i] === 'x', italic: marks[i] === 'i' || marks[i] === 'x' }))

    test('bolding a word writes 1/2 toggles that linearize as a bold span', () => {
        const doc = RmDocument.empty(WEB)
        createRootText(doc)
        insertText(doc, null, 'hello world', { authorUuid: WEB })
        //                     hello_WORLD
        applyPlan(doc, T('hello world', '......bbbbb'))
        const back = roundtrip(doc)
        expect(spansOf(back)).toEqual([
            [
                { text: 'hello ', bold: false, italic: false },
                { text: 'world', bold: true, italic: false },
            ],
        ])
        // idempotent: matching marks produce an empty plan
        const again = planFormatEdits(back.tree().rootText!, T('hello world', '......bbbbb'))!
        expect(again.deleteIds).toHaveLength(0)
        expect(again.inserts).toHaveLength(0)
    })

    test('un-bolding tombstones the codes (rewrite is canonical)', () => {
        const doc = RmDocument.empty(WEB)
        createRootText(doc)
        insertText(doc, null, 'abc', { authorUuid: WEB })
        applyPlan(doc, T('abc', 'bbb'))
        expect(spansOf(doc)[0]![0]).toEqual({ text: 'abc', bold: true, italic: false })
        applyPlan(doc, T('abc', '...'))
        const back = roundtrip(doc)
        expect(spansOf(back)).toEqual([[{ text: 'abc', bold: false, italic: false }]])
    })

    test('bold+italic overlap and paragraph boundaries', () => {
        const doc = RmDocument.empty(WEB)
        createRootText(doc)
        insertText(doc, null, 'ab\ncd', { authorUuid: WEB })
        // 'b' bold, whole second paragraph italic
        applyPlan(doc, [
            { bold: false, italic: false },
            { bold: true, italic: false },
            { bold: false, italic: true },
            { bold: false, italic: true },
        ])
        const back = roundtrip(doc)
        expect(spansOf(back)).toEqual([
            [
                { text: 'a', bold: false, italic: false },
                { text: 'b', bold: true, italic: false },
            ],
            [{ text: 'cd', bold: false, italic: true }],
        ])
    })

    test('bold+italic on the SAME char sanitizes to italic (device cannot overlap)', () => {
        const doc = RmDocument.empty(WEB)
        createRootText(doc)
        insertText(doc, null, 'mixed both mixed', { authorUuid: WEB })
        applyPlan(doc, T('mixed both mixed', '......xxxx......'))
        const back = roundtrip(doc)
        expect(spansOf(back)).toEqual([
            [
                { text: 'mixed ', bold: false, italic: false },
                { text: 'both', bold: false, italic: true },
                { text: ' mixed', bold: false, italic: false },
            ],
        ])
        // idempotent under the same conflicted target
        const again = planFormatEdits(back.tree().rootText!, T('mixed both mixed', '......xxxx......'))!
        expect(again.deleteIds).toHaveLength(0)
        expect(again.inserts).toHaveLength(0)
    })

    test('length mismatch returns null (text diff not settled)', () => {
        const doc = RmDocument.empty(WEB)
        createRootText(doc)
        insertText(doc, null, 'abc', { authorUuid: WEB })
        expect(planFormatEdits(doc.tree().rootText!, T('ab', '..'))).toBeNull()
        expect(planFormatEdits(doc.tree().rootText!, T('abcd', '....'))).toBeNull()
    })

    test('marks survive deletes that split runs around the codes', () => {
        const doc = RmDocument.empty(WEB)
        createRootText(doc)
        insertText(doc, null, 'one two three', { authorUuid: WEB })
        applyPlan(doc, T('one two three', '....bbb......'))
        // delete "two" (the bold word): codes around it stay consistent
        const positions = rootTextCharPositions(doc.tree().rootText!).filter((c) => !c.deleted)
        deleteText(doc, positions.slice(4, 7).map((c) => c.id))
        const back = roundtrip(doc)
        const flat = spansOf(back)[0]!
        expect(flat.map((s) => s.text).join('')).toBe('one  three')
        // re-plan to all-plain: the stale toggles get cleaned up
        applyPlan(back, T('one  three', '..........'))
        expect(spansOf(back)[0]!.every((s) => !s.bold && !s.italic)).toBe(true)
    })
})

test('equal paragraph style clocks prefer the smaller wire author UUID in either merge order', () => {
    // These UUIDs are deliberately ordered differently as strings and on wire.
    const canonicalFirst = '00000001-0000-4000-a000-000000000001'
    const wireFirst = '00000100-0000-4000-a000-000000000001'
    const doc = RmDocument.empty(TABLET)
    createRootText(doc)
    insertText(doc, null, 'Styled paragraph', { authorUuid: TABLET })

    const style = (authorUuid: string, value: ParagraphStyle, clock: number) => {
        const copy = roundtrip(doc)
        const author = copy.resolveAuthor(authorUuid)
        copy.rootTextBlock!.text.styles.set('0:0', { timestamp: crdtId(author, clock), value })
        return copy
    }
    const winner = style(wireFirst, ParagraphStyle.HEADING, 100)
    const loser = style(canonicalFirst, ParagraphStyle.PLAIN, 100)
    for (const [source, incoming] of [[winner, loser], [loser, winner]] as const) {
        const head = roundtrip(source)
        mergeRootTextInto(head, incoming)
        const merged = roundtrip(head)
        const result = merged.rootTextBlock!.text.styles.get('0:0')!
        expect(result.value).toBe(ParagraphStyle.HEADING)
        expect(result.timestamp.part2).toBe(100)
        expect(merged.authorTable().get(result.timestamp.part1)).toBe(wireFirst)
    }

    const later = style(canonicalFirst, ParagraphStyle.PLAIN, 101)
    mergeRootTextInto(winner, later)
    expect(roundtrip(winner).rootTextBlock!.text.styles.get('0:0')!.value).toBe(ParagraphStyle.PLAIN)
})

test('an unresolved non-system author does not win an equal paragraph style clock', () => {
    const doc = RmDocument.empty(TABLET)
    createRootText(doc)
    insertText(doc, null, 'Styled paragraph', { authorUuid: TABLET })
    const unresolved = roundtrip(doc)
    unresolved.rootTextBlock!.text.styles.set('0:0', {
        timestamp: crdtId(40, 100), value: ParagraphStyle.HEADING,
    })
    expect(unresolved.authorTable().has(40)).toBe(false)
    const resolved = roundtrip(doc)
    resolved.rootTextBlock!.text.styles.set('0:0', {
        timestamp: crdtId(resolved.resolveAuthor(TABLET), 100), value: ParagraphStyle.BOLD,
    })

    for (const [source, incoming] of [[unresolved, resolved], [resolved, unresolved]] as const) {
        const head = roundtrip(source)
        mergeRootTextInto(head, incoming)
        const actual = roundtrip(head).rootTextBlock!.text.styles.get('0:0')!
        expect(actual.value).toBe(ParagraphStyle.BOLD)
    }
})


test('an incoming paragraph style replaces the identical author and clock register', () => {
    const local = RmDocument.empty(TABLET)
    createRootText(local)
    insertText(local, null, 'Styled paragraph', { authorUuid: TABLET })
    const stamp = crdtId(local.resolveAuthor(TABLET), 100)
    local.rootTextBlock!.text.styles.set('0:0', { timestamp: stamp, value: ParagraphStyle.HEADING })
    const incoming = roundtrip(local)
    incoming.rootTextBlock!.text.styles.set('0:0', { timestamp: stamp, value: ParagraphStyle.BOLD })
    mergeRootTextInto(local, incoming)
    expect(roundtrip(local).rootTextBlock!.text.styles.get('0:0')).toEqual({
        timestamp: stamp,
        value: ParagraphStyle.BOLD,
    })
})

test('an incoming text author cannot acquire an unresolved origin slot', () => {
    const baseAuthor = 'a0000000-0000-4000-a000-000000000001'
    const newAuthor = 'a0000000-0000-4000-a000-000000000002'
    const base = RmDocument.empty(baseAuthor)
    createRootText(base)
    const incoming = RmDocument.empty(newAuthor)
    createRootText(incoming)
    insertText(incoming, null, 'Text', { authorUuid: newAuthor })
    incoming.rootTextBlock!.textItems[0]!.leftId = crdtId(2, 27)
    mergeRootTextInto(base, incoming)
    expect(base.authorTable().has(2)).toBe(false)
    expect(base.authorTable().get(3)).toBe(newAuthor)
    expect(base.rootTextBlock!.textItems[0]!.leftId).toEqual(crdtId(2, 27))
})

test('browser paragraph size changes preserve native indent and opaque properties', () => {
    const original = RmDocument.empty(TABLET)
    createRootText(original)
    insertText(original, null, 'Styled paragraph', { authorUuid: TABLET })
    const indent = encodeStyleExtra({ indent: 2 })!
    const size = encodeStyleExtra({ size: 3 })!
    const nativeProperty = Uint8Array.of(0x21, 11, 0x34, 4, 0, 0, 0)
    const opaqueTail = Uint8Array.of(0x71, 0x0f)
    const key = crdtIdKey(crdtId(0, 0))
    original.rootTextBlock!.text.styles.set(key, {
        timestamp: crdtId(1, 100), value: ParagraphStyle.HEADING,
        extra: Uint8Array.of(...indent, ...size, ...nativeProperty, ...opaqueTail),
    })
    const newSize = encodeStyleExtra({ size: 2 })!
    setParagraphStyle(original, crdtId(0, 0), ParagraphStyle.HEADING, { authorUuid: WEB, extra: newSize })
    const changed = roundtrip(original)
    expect(changed.rootTextBlock!.text.styles.get(key)?.extra).toEqual(
        Uint8Array.of(...indent, ...newSize, ...nativeProperty, ...opaqueTail),
    )
    setParagraphStyle(changed, crdtId(0, 0), ParagraphStyle.BOLD, { authorUuid: WEB })
    expect(roundtrip(changed).rootTextBlock!.text.styles.get(key)?.extra).toEqual(
        Uint8Array.of(...indent, ...nativeProperty, ...opaqueTail),
    )
})
