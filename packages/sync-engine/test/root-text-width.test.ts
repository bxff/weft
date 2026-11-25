import { expect, test } from 'bun:test'
import { RmDocument, TaggedBlockWriter, crdtId, createRootText, insertText, mergeRootTextInto } from '@weft/rm-format'
import { diffToOps, mergeForSnapshot } from '../src/bridge'

const BASE_AUTHOR = '00000001-0000-4000-a000-000000000001'
const OTHER_AUTHOR = '00000100-0000-4000-a000-000000000001'

function page(author: string, width: number, clock: number, slot = 1, text = '', legacyWidth = 936): Uint8Array {
    const doc = RmDocument.empty(author)
    createRootText(doc, { posX: -410, posY: 250, width: legacyWidth })
    if (text) insertText(doc, null, text, { authorUuid: author })
    const root = doc.blocks.find(block => block.type === 'rootText')!
    const writer = new TaggedBlockWriter()
    writer.subblock(5, () => {
        writer.subblock(1, () => {
            writer.writeId(1, crdtId(slot, clock))
            writer.writeFloat(2, width)
            writer.writeByte(3, 34)
        })
        writer.writeByte(2, 56)
    })
    writer.writeByte(6, 78)
    root.extraData = writer.getBytes()
    return doc.serialize()
}

test('uses the current width and reserves its timestamp while preserving the complete wire record', () => {
    const bytes = page(BASE_AUTHOR, 700, 101, 2)
    const doc = RmDocument.parse(bytes)
    expect(doc.tree().rootText).toMatchObject({ width: 700, posX: -410, posY: 250 })
    expect(doc.serialize()).toEqual(bytes)
    expect(insertText(doc, null, 'A', { authorUuid: OTHER_AUTHOR })).toEqual(crdtId(3, 102))
})

test('width-only changes require snapshot fallback, including a timestamp-only update', () => {
    const base = page(BASE_AUTHOR, 936, 100)
    expect(diffToOps(base, page(BASE_AUTHOR, 700, 101))).toEqual({ complete: false, ops: [] })
    expect(diffToOps(base, page(BASE_AUTHOR, 936, 101))).toEqual({ complete: false, ops: [] })
})

test('snapshot merge keeps the winning width and remaps its author', () => {
    const base = page(BASE_AUTHOR, 936, 100)
    const other = page(OTHER_AUTHOR, 700, 101)
    const doc = RmDocument.parse(mergeForSnapshot(base, other))
    expect(doc.tree().rootText).toMatchObject({ width: 700, posX: -350, posY: 234 })
    expect(doc.authorTable().get(2)).toBe(OTHER_AUTHOR)
    expect(doc.maxClock()).toBe(101)
    expect(mergeForSnapshot(base, page(OTHER_AUTHOR, 800, 99))).toEqual(base)
})

test('snapshot merge remaps width even when the destination has no root text', () => {
    const base = RmDocument.empty(BASE_AUTHOR).serialize()
    const doc = RmDocument.parse(mergeForSnapshot(base, page(OTHER_AUTHOR, 700, 101)))
    expect(doc.tree().rootText).toMatchObject({ width: 700, posX: -410, posY: 250 })
    expect(doc.authorTable().get(2)).toBe(OTHER_AUTHOR)
    expect(doc.maxClock()).toBe(101)
})

test('width changes preserve the destination extension bytes', () => {
    const base = page(BASE_AUTHOR, 936, 100)
    const doc = RmDocument.parse(mergeForSnapshot(base, page(OTHER_AUTHOR, 700, 101)))
    const root = doc.blocks.find(block => block.type === 'rootText')!
    expect(root.widthData?.register).toEqual({
        timestamp: crdtId(2, 101),
        value: 700,
        extraData: Uint8Array.of(0x31, 34),
    })
    expect(root.widthData?.extraData).toEqual(Uint8Array.of(0x21, 56))
    expect(root.extraData).toEqual(Uint8Array.of(0x61, 78))
})

test('equal-clock width writes compare UUID bytes rather than local slots', () => {
    const higher = page(OTHER_AUTHOR, 700, 101)
    const lower = page(BASE_AUTHOR, 800, 101)
    expect(mergeForSnapshot(higher, lower)).toEqual(higher)
    const result = RmDocument.parse(mergeForSnapshot(lower, higher))
    expect(result.tree().rootText?.width).toBe(700)
    expect(result.authorTable().get(2)).toBe(OTHER_AUTHOR)
})

test('a newer timestamp for the same width keeps the stored origin', () => {
    const base = page(BASE_AUTHOR, 700, 100)
    const result = RmDocument.parse(mergeForSnapshot(base, page(OTHER_AUTHOR, 700, 101)))
    expect(result.tree().rootText).toMatchObject({ width: 700, posX: -410, posY: 250 })
    expect(result.maxClock()).toBe(101)
})

test('a zero registered width keeps the serialized legacy width on parse', () => {
    const bytes = page(BASE_AUTHOR, 0, 101)
    const doc = RmDocument.parse(bytes)
    expect(doc.tree().rootText).toMatchObject({ width: 936, posX: -410, posY: 250 })
    expect(doc.serialize()).toEqual(bytes)
    expect(doc.maxClock()).toBe(101)
})

test('an unresolved width author does not prevent importing text or replace the destination width', () => {
    const base = page(BASE_AUTHOR, 936, 100)
    const other = page(OTHER_AUTHOR, 700, 101, 2, 'preserve this text')
    const result = RmDocument.parse(mergeForSnapshot(base, other))
    const root = result.blocks.find(block => block.type === 'rootText')!
    expect(root.textItems.map(item => item.value)).toContain('preserve this text')
    expect(root.text.width).toBe(936)
    expect(root.widthData?.register?.timestamp).toEqual(crdtId(1, 100))
})

test('adopting a root from an unresolved width author keeps the width with no foreign stamp', () => {
    const base = RmDocument.empty(BASE_AUTHOR).serialize()
    const other = page(OTHER_AUTHOR, 700, 101, 2, 'preserve this text')
    const result = RmDocument.parse(mergeForSnapshot(base, other))
    const root = result.blocks.find(block => block.type === 'rootText')!
    expect(root.textItems.map(item => item.value)).toContain('preserve this text')
    expect(root.text.width).toBe(700)
    expect(root.widthData?.register).toEqual({
        timestamp: crdtId(0, 0),
        value: 0,
        extraData: Uint8Array.of(0x31, 34),
    })
})

test('an edit to the public width persists with or without a positive registered width', () => {
    for (const registeredWidth of [0, 700]) {
        const doc = RmDocument.parse(page(BASE_AUTHOR, registeredWidth, 101))
        doc.tree().rootText!.width = 800
        const reparsed = RmDocument.parse(doc.serialize())
        expect(reparsed.tree().rootText).toMatchObject({ width: 800, posX: -410, posY: 250 })
        const root = reparsed.blocks.find(block => block.type === 'rootText')!
        expect(root.widthData?.register?.timestamp).toEqual(crdtId(1, 101))
    }
})

test('partial width registers use defaults and preserve their field omissions', () => {
    for (const [timestamp, value] of [[true, false], [false, true], [false, false]] as const) {
        const doc = RmDocument.empty(BASE_AUTHOR)
        createRootText(doc)
        const root = doc.blocks.find(block => block.type === 'rootText')!
        const writer = new TaggedBlockWriter()
        writer.subblock(5, () => {
            writer.subblock(1, () => {
                if (timestamp) writer.writeId(1, crdtId(1, 101))
                if (value) writer.writeFloat(2, 700)
                writer.writeByte(3, 34)
            })
            writer.writeByte(2, 56)
        })
        writer.writeByte(6, 78)
        root.extraData = writer.getBytes()
        const bytes = doc.serialize()
        const parsed = RmDocument.parse(bytes)
        expect(parsed.tree().rootText?.width).toBe(value ? 700 : 936)
        expect(parsed.serialize()).toEqual(bytes)
    }
})

test('a different width with the same author and timestamp wins when merged as incoming', () => {
    const base = page(BASE_AUTHOR, 700, 101)
    const doc = RmDocument.parse(mergeForSnapshot(base, page(BASE_AUTHOR, 800, 101)))
    expect(doc.tree().rootText).toMatchObject({ width: 800, posX: -400, posY: 234 })
    expect(doc.authorTable().size).toBe(1)
})

test('a winning width cannot replace a destination implicit author table', () => {
    const implicit = RmDocument.parse(page(BASE_AUTHOR, 936, 100, 1, 'base text'))
    implicit.blocks.shift()
    const baseline = implicit.serialize()
    expect(() => mergeForSnapshot(baseline, page(OTHER_AUTHOR, 700, 101))).toThrow('unresolved author')
    expect(implicit.serialize()).toEqual(baseline)
})

test('a full author table keeps the current width if the incoming author cannot be registered', () => {
    const base = RmDocument.parse(page(BASE_AUTHOR, 936, 100))
    const registry = base.blocks.find(block => block.type === 'authorIds')!
    for (let slot = 2; slot <= 0xff; slot++) {
        registry.authors.set(slot, BASE_AUTHOR)
    }
    mergeRootTextInto(base, RmDocument.parse(page(OTHER_AUTHOR, 700, 101)))
    expect(base.tree().rootText?.width).toBe(936)
    expect(registry.authors.size).toBe(0xff)
})

test('the last author slot goes to the incoming text before optional width metadata', () => {
    const base = RmDocument.parse(page(BASE_AUTHOR, 936, 100))
    const registry = base.blocks.find(block => block.type === 'authorIds')!
    for (let slot = 2; slot < 0xff; slot++) {
        registry.authors.set(slot, BASE_AUTHOR)
    }
    const other = RmDocument.parse(page(OTHER_AUTHOR, 700, 101, 2, 'incoming text'))
    other.blocks.find(block => block.type === 'authorIds')!.authors.set(2, 'abcdef01-0000-4000-a000-000000000001')
    mergeRootTextInto(base, other)
    const root = base.blocks.find(block => block.type === 'rootText')!
    expect(root.textItems[0]?.value).toBe('incoming text')
    expect(root.textItems[0]?.itemId.part1).toBe(0xff)
    expect(registry.authors.get(0xff)).toBe(OTHER_AUTHOR)
    expect(root.text.width).toBe(936)
})

test('importing a width author does not claim an unresolved incoming text slot', () => {
    const base = RmDocument.parse(page(BASE_AUTHOR, 936, 100))
    const other = RmDocument.parse(page(OTHER_AUTHOR, 700, 101, 1, 'unresolved text'))
    other.blocks.find(block => block.type === 'rootText')!.textItems[0]!.itemId = crdtId(2, 50)
    const result = RmDocument.parse(mergeForSnapshot(base.serialize(), other.serialize()))
    const root = result.blocks.find(block => block.type === 'rootText')!
    expect(root.textItems[0]?.itemId.part1).toBe(2)
    expect(result.authorTable().has(2)).toBe(false)
    expect(root.widthData?.register?.timestamp).toEqual(crdtId(3, 101))
    expect(result.authorTable().get(3)).toBe(OTHER_AUTHOR)
})

test('merging a winning negative register keeps both wire values and reads effective width zero', () => {
    const base = RmDocument.parse(page(BASE_AUTHOR, 700, 100))
    const other = RmDocument.parse(page(OTHER_AUTHOR, -200, 101))
    expect(other.tree().rootText?.width).toBe(936)
    mergeRootTextInto(base, other)
    expect(base.tree().rootText?.width).toBe(0)
    const result = RmDocument.parse(base.serialize())
    const root = result.blocks.find(block => block.type === 'rootText')!
    expect(root.text).toMatchObject({ width: 0, posX: 100, posY: 234 })
    expect(root.widthData?.legacy).toBe(-200)
    expect(root.widthData?.register?.value).toBe(-200)
})

test('untouched negative width fields round-trip while a direct positive edit persists', () => {
    const bytes = page(BASE_AUTHOR, -200, 101, 1, '', -100)
    const doc = RmDocument.parse(bytes)
    expect(doc.tree().rootText?.width).toBe(0)
    expect(doc.serialize()).toEqual(bytes)
    doc.tree().rootText!.width = 800
    const reparsed = RmDocument.parse(doc.serialize())
    expect(reparsed.tree().rootText?.width).toBe(800)
    expect(reparsed.blocks.find(block => block.type === 'rootText')!.widthData?.register?.value).toBe(-200)
})
