/**
 * Root-text MUTATION: mint typed-text edits under our author identity, the
 * same CRDT discipline the ink uses (E2). Items are runs with implicit
 * per-char ids; deletions TOMBSTONE (deletedLength, ids preserved — anchors
 * and ordering depend on them); styles are per-paragraph LWW. The device
 * merges these like any other author's edits.
 */

import { type CrdtId, type LwwValue, crdtId, crdtIdEquals, crdtIdKey, lww } from './crdt-id'
import { CrdtSequence, type CrdtSequenceItem } from './crdt-sequence'
import type { Text } from './scene-items'
import { expandItem, paragraphStyleWriteExtra } from './text-doc'
import type { RmDocument } from './document'
import { uuidToBytesLE, effectiveRootTextWidth, type RootTextBlock, type TextItem } from './blocks'

const ZERO = crdtId(0, 0)
const EMPTY = new Uint8Array(0)
const SYSTEM_UUID = '00000000-0000-0000-0000-000000000000'

/** Rebuild the parsed-view sequence from the raw items after a mutation.
 *  EXPANDED to per-char items: run-level integration cannot place an item
 *  whose left id points INSIDE another run (mid-run inserts, the normal
 *  case) — the linearizer expands for the same reason. */
function reindex(block: RootTextBlock): void {
    block.text.items = new CrdtSequence<string | number>(
        block.textItems.flatMap((i) => [
            ...expandItem(i as CrdtSequenceItem<string | number>),
        ]),
    )
}

/** Create an empty root text column (device defaults) on a page without
 *  one. Throws if the page already has typed text. */
export function createRootText(
    doc: RmDocument,
    opts: { posX?: number; posY?: number; width?: number } = {},
): void {
    if (doc.rootTextBlock) throw new Error('page already has root text')
    const text: Text = {
        kind: 'text',
        items: new CrdtSequence<string | number>([]),
        styles: new Map(),
        posX: opts.posX ?? -468,
        posY: opts.posY ?? 234,
        width: opts.width ?? 936,
    }
    const block: RootTextBlock = {
        type: 'rootText',
        // BlockVersion is {min,current}; a bare `1` serialized as {0,0} (via the
        // cast) and real xochitl rootText is {1,1} — a wrong version can make the
        // device drop web-created text.
        version: { min: 1, current: 1 },
        extraData: new Uint8Array(0),
        blockId: ZERO,
        text,
        textItems: [],
    } as unknown as RootTextBlock
    doc.blocks.push(block)
}

/** Expanded (per-char) ids in document order, tombstones included. */
function expandedIds(block: RootTextBlock): {
    ids: CrdtId[]
    at: Map<string, CrdtSequenceItem<string | number>>
} {
    const seq = new CrdtSequence<string | number>(
        block.textItems.flatMap((i) => [...expandItem(i as CrdtSequenceItem<string | number>)]),
    )
    const ids = seq.orderedIds()
    const at = new Map(ids.map((id) => [crdtIdKey(id), seq.getItem(id)!]))
    return { ids, at }
}

/**
 * Insert `text` after the visible character `afterId` (or at the very
 * start with afterId null). Returns the first new char's id — inserting a
 * '\n' makes that id the new paragraph's style anchor.
 */
export function insertText(
    doc: RmDocument,
    afterId: CrdtId | null,
    text: string,
    opts: { authorUuid: string },
): CrdtId {
    if (text.length === 0) throw new Error('empty insert')
    return insertTextItem(doc, afterId, text, opts.authorUuid)
}

/**
 * Insert an inline FORMAT CODE (1/2 bold on/off, 3/4 italic on/off) after
 * `afterId` (null = document start). Codes are single-value items in the
 * same character sequence — that is how xochitl stores span bold/italic
 * (read from real device files; the linearizer runs them as a state
 * machine). Returns the new item's id so callers can chain insertions.
 */
export function insertFormatCode(
    doc: RmDocument,
    afterId: CrdtId | null,
    code: number,
    opts: { authorUuid: string },
): CrdtId {
    return insertTextItem(doc, afterId, code, opts.authorUuid)
}

function insertTextItem(
    doc: RmDocument,
    afterId: CrdtId | null,
    value: string | number,
    authorUuid: string,
): CrdtId {
    const block = doc.rootTextBlock
    if (!block) throw new Error('no root text (createRootText first)')
    const author = doc.resolveAuthor(authorUuid)
    const itemId = crdtId(author, doc.maxClock(author) + 1)
    let leftId = ZERO
    let rightId = ZERO
    const { ids } = expandedIds(block)
    if (afterId) {
        const i = ids.findIndex((id) => crdtIdEquals(id, afterId))
        if (i < 0) throw new Error(`unknown afterId ${crdtIdKey(afterId)}`)
        leftId = ids[i]!
        rightId = i + 1 < ids.length ? ids[i + 1]! : ZERO
    } else {
        rightId = ids[0] ?? ZERO
    }
    block.textItems.push({ itemId, leftId, rightId, deletedLength: 0, value })
    reindex(block)
    return itemId
}

/**
 * Tombstone the visible characters whose EXPANDED ids are in `ids`. Runs
 * are split so untouched characters keep their exact implicit ids; deleted
 * spans keep theirs too (deletedLength) — anchors may point at them.
 */
export function deleteText(doc: RmDocument, ids: CrdtId[]): void {
    const block = doc.rootTextBlock
    if (!block) throw new Error('no root text')
    deleteTextFromBlock(block, ids)
}

function deleteTextFromBlock(block: RootTextBlock, ids: CrdtId[]): void {
    if (ids.length === 0) return
    const kill = new Set(ids.map(crdtIdKey))
    const out: TextItem[] = []
    for (const item of block.textItems) {
        const chars = [...expandItem(item as CrdtSequenceItem<string | number>)]
        const touched = chars.some((c) => kill.has(crdtIdKey(c.itemId)))
        if (!touched) {
            out.push(item)
            continue
        }
        // split the run into kept / tombstoned segments, preserving ids
        let seg: CrdtSequenceItem<string | number>[] = []
        let segDeleted: boolean | null = null
        const flush = () => {
            if (seg.length === 0) return
            const first = seg[0]!
            const last = seg[seg.length - 1]!
            const wasDeleted = (first.deletedLength ?? 0) > 0
            const nowDeleted = segDeleted === true || wasDeleted
            out.push({
                itemId: first.itemId,
                leftId: first.leftId,
                // xochitl's split convention (read from real device files):
                // pieces chain by LEFT refs only; the right stays open (0:0)
                // except the final piece, which keeps the run's original R.
                // Explicitly chained rights corrupt the device's splice when
                // it later re-splits one of the pieces.
                rightId: crdtIdEquals(last.rightId, item.rightId) ? item.rightId : ZERO,
                deletedLength: nowDeleted ? seg.length : 0,
                // xochitl writes NO value subblock for tombstones (null) —
                // an empty-string value is a different wire shape the device
                // mishandles when it later re-splits the run
                value: nowDeleted ? null : seg.map((c) => c.value as string).join(''),
            })
            seg = []
        }
        for (const c of chars) {
            const del = kill.has(crdtIdKey(c.itemId)) || (c.deletedLength ?? 0) > 0
            if (typeof c.value === 'number') {
                // format codes are single items; emit them verbatim so a
                // kept text segment never swallows a bold/italic toggle
                flush()
                segDeleted = null
                out.push({
                    itemId: c.itemId,
                    leftId: c.leftId,
                    rightId: c.rightId,
                    deletedLength: del ? 1 : 0,
                    value: del ? null : c.value,
                })
                continue
            }
            if (segDeleted === null) segDeleted = del
            if (del !== segDeleted) {
                flush()
                segDeleted = del
            }
            seg.push(c)
        }
        flush()
    }
    block.textItems = out
    reindex(block)
}

export interface FormatPlan {
    /** live format-code item ids to tombstone (via deleteText). */
    deleteIds: CrdtId[]
    /** toggle codes to insert, chained after `afterId` (null = doc start).
     *  Codes at one boundary are ordered and must chain (each after the
     *  previous inserted code) — apply-ops does the chaining. */
    inserts: { afterId: CrdtId | null; codes: number[] }[]
}

/**
 * Plan the format-code edits that make the live text's bold/italic match
 * `target` (one entry per VISIBLE live char, in linearized order, '\n'
 * excluded). Returns null when target length doesn't match the live char
 * count (caller's text diff hasn't settled); an EMPTY plan when marks
 * already match (idempotence — no rewrite loops). On any mismatch the plan
 * rewrites: tombstone every live code, re-insert minimal toggles at state
 * boundaries. The linearizer's state machine renders either encoding
 * identically; rewriting keeps the code stream canonical.
 */
export function planFormatEdits(
    text: Text,
    target: { bold: boolean; italic: boolean }[],
): FormatPlan | null {
    // xochitl cannot render overlapping bold+italic: a nested or crossing
    // region silently drops the bold (no combo code; 5/6 are ignored).
    // Sanitize to match the device's own conflict resolution: italic wins.
    target = target.map((t) => (t.bold && t.italic ? { bold: false, italic: true } : t))
    const seq = new CrdtSequence<string | number>(
        text.items.allItems().flatMap((i) => [...expandItem(i)]),
    )
    const ordered = seq.orderedIds()

    // pass 1: does the current code stream already produce `target`?
    let bold = false
    let italic = false
    let k = 0
    let mismatch = false
    const liveCodes: CrdtId[] = []
    for (const id of ordered) {
        const item = seq.getItem(id)!
        if ((item.deletedLength ?? 0) > 0) continue
        const v = item.value
        if (typeof v === 'number') {
            liveCodes.push(id)
            if (v === 1) bold = true
            else if (v === 2) bold = false
            else if (v === 3) italic = true
            else if (v === 4) italic = false
            continue
        }
        if (v === '\n') continue
        const want = target[k]
        if (!want) return null // more live chars than target
        if (bold !== want.bold || italic !== want.italic) mismatch = true
        k++
    }
    if (k !== target.length) return null
    if (!mismatch) return { deleteIds: [], inserts: [] }

    // pass 2: fresh minimal toggles (all existing codes get tombstoned, so
    // they are neither state nor anchors here)
    const inserts: FormatPlan['inserts'] = []
    let b = false
    let i2 = false
    let prevId: CrdtId | null = null
    k = 0
    for (const id of ordered) {
        const item = seq.getItem(id)!
        if ((item.deletedLength ?? 0) > 0) continue
        const v = item.value
        if (typeof v === 'number') continue
        if (v === '\n') {
            prevId = id
            continue
        }
        const want = target[k++]!
        const codes: number[] = []
        if (want.bold !== b) {
            codes.push(want.bold ? 1 : 2)
            b = want.bold
        }
        if (want.italic !== i2) {
            codes.push(want.italic ? 3 : 4)
            i2 = want.italic
        }
        if (codes.length) inserts.push({ afterId: prevId, codes })
        prevId = id
    }
    return { deleteIds: liveCodes, inserts }
}

/** Set a paragraph's style (LWW under our author's fresh timestamp). The
 *  anchor is the '\n' that opens the paragraph, or 0:0 for the first. */
export function setParagraphStyle(
    doc: RmDocument,
    anchorId: CrdtId,
    style: number,
    opts: { authorUuid: string; extra?: Uint8Array },
): void {
    const block = doc.rootTextBlock
    if (!block) throw new Error('no root text')
    const author = doc.resolveAuthor(opts.authorUuid)
    const ts = crdtId(author, doc.maxClock(author) + 1)
    const key = crdtIdKey(anchorId)
    const extra = paragraphStyleWriteExtra(block.text.styles.get(key)?.extra, opts.extra)
    block.text.styles.set(key, { ...lww(ts, style), ...(extra?.length && { extra }) })
}

/** Prefer the smaller wire UUID at equal clocks. An identical stamp takes the incoming value. */
function textRegisterWins(
    incoming: CrdtId,
    current: CrdtId,
    incomingAuthors: ReadonlyMap<number, string>,
    currentAuthors: ReadonlyMap<number, string>,
): boolean {
    if (incoming.part2 !== current.part2) return incoming.part2 > current.part2
    const incomingUuid = incoming.part1 === 0 ? SYSTEM_UUID : incomingAuthors.get(incoming.part1)
    const currentUuid = current.part1 === 0 ? SYSTEM_UUID : currentAuthors.get(current.part1)
    if (!incomingUuid) return !currentUuid && incoming.part1 > current.part1
    if (!currentUuid) return true
    const incomingWire = uuidToBytesLE(incomingUuid)
    const currentWire = uuidToBytesLE(currentUuid)
    for (let i = 0; i < incomingWire.length; i++) {
        if (incomingWire[i] !== currentWire[i]) return incomingWire[i]! < currentWire[i]!
    }
    return true
}

export class RootTextAuthorConflict extends Error {}

function textAuthorSlots(block: RootTextBlock | null): Set<number> {
    const result = new Set<number>()
    if (!block) return result
    result.add(block.blockId.part1)
    for (const item of block.textItems) {
        result.add(item.itemId.part1)
        result.add(item.leftId.part1)
        result.add(item.rightId.part1)
    }
    for (const [key, style] of block.text.styles) {
        result.add(Number(key.split(':')[0]))
        result.add(style.timestamp.part1)
    }
    result.delete(0)
    return result
}

/** Refuse a merge that would give an unresolved ID a different author. */
export function rootTextUnresolvedMergeSlots(base: RmDocument, other: RmDocument): Set<number> {
    if (!other.rootTextBlock) return new Set()
    const baseAuthors = base.authorTable()
    const otherAuthors = other.authorTable()
    const baseSlots = [...textAuthorSlots(base.rootTextBlock)].filter(slot => !baseAuthors.has(slot))
    const otherSlots = [...textAuthorSlots(other.rootTextBlock)].filter(slot => !otherAuthors.has(slot))
    const baseExplicit = base.blocks.some(block => block.type === 'authorIds')
    const otherExplicit = other.blocks.some(block => block.type === 'authorIds')
    const conflict = (slots: number[], peerAuthors: ReadonlyMap<number, string>) =>
        slots.some(slot => baseExplicit !== otherExplicit || peerAuthors.has(slot))
    if (conflict(baseSlots, otherAuthors) || conflict(otherSlots, baseAuthors)) {
        throw new RootTextAuthorConflict('Root text refers to an unresolved author in a different author table')
    }
    return new Set([...baseSlots, ...otherSlots])
}

/**
 * CRDT-merge `other`'s root text INTO `base` (union per expanded char id,
 * DELETED WINS; styles LWW by timestamp). This is how concurrent tablet and
 * web typing reconcile instead of last-push-wins: both sides' characters
 * carry stable ids, so the union is exactly the merged document. `base`
 * keeps its own column position.
 */
export function mergeRootTextInto(base: RmDocument, other: RmDocument): void {
    const ob = other.rootTextBlock
    if (!ob) return
    // AUTHOR REMAP (E2): item ids are (authorIndex, clock) with FILE-LOCAL
    // indices. Copying another file's items verbatim hands xochitl ids whose
    // author index means a different (or no) author here — the device then
    // rejects the refs and APPENDS the text at the end (device-verified).
    const reserved = rootTextUnresolvedMergeSlots(base, other)
    const bb = base.rootTextBlock
    const currentWidth = bb?.widthData?.register
    const otherAuthors = other.authorTable()
    const existingAuthors = new Map([...base.authorTable()].filter(([slot]) => slot !== 0)
        .reverse().map(([slot, uuid]) => [uuid.toLowerCase(), slot]))
    const indexMap = new Map<number, number>()
    const pendingAuthors = new Set<string>()
    let draft: RmDocument | undefined
    for (const slot of textAuthorSlots(ob)) {
        const uuid = otherAuthors.get(slot)
        if (!uuid) continue
        let mapped = existingAuthors.get(uuid.toLowerCase())
        if (mapped === undefined) {
            draft ??= base.forkForInkEdits()
            try {
                mapped = draft.resolveAuthor(uuid, reserved)
            } catch {
                throw new RootTextAuthorConflict('Root text needs a new author slot, but the page author table is full')
            }
            pendingAuthors.add(uuid)
        }
        indexMap.set(slot, mapped)
    }
    for (const uuid of pendingAuthors) base.resolveAuthor(uuid, reserved)
    const remap = (id: CrdtId): CrdtId => {
        const mapped = indexMap.get(id.part1) ?? id.part1
        return mapped === id.part1 ? id : crdtId(mapped, id.part2)
    }
    const remapItem = (c: TextItem): TextItem => ({
        ...c,
        itemId: remap(c.itemId),
        leftId: remap(c.leftId),
        rightId: remap(c.rightId),
    })
    const remapStyles = (styles: Map<string, LwwValue<number>>) =>
        new Map(
            [...styles.entries()].map(([key, sv]) => {
                const [p1, p2] = key.split(':').map(Number)
                return [
                    crdtIdKey(remap(crdtId(p1!, p2!))),
                    { ...sv, timestamp: remap(sv.timestamp) },
                ] as const
            }),
        )

    const sourceWidth = ob.widthData?.register
    let incomingWidth: typeof sourceWidth
    if (sourceWidth) {
        const stamp = sourceWidth.timestamp
        const destination = base.authorTable()
        const currentStamp = currentWidth?.timestamp ?? ZERO
        const comparable = currentStamp.part1 && !destination.has(currentStamp.part1)
            ? crdtId(0, currentStamp.part2)
            : currentStamp
        if (!bb || textRegisterWins(stamp, comparable, otherAuthors, destination)) {
            if (stamp.part1 === 0) incomingWidth = sourceWidth
            else {
                const uuid = otherAuthors.get(stamp.part1)
                // An optional width must not establish a registry for an implicit page.
                if (uuid && base.blocks.some(block => block.type === 'authorIds')) {
                    try {
                        incomingWidth = { ...sourceWidth, timestamp: crdtId(base.resolveAuthor(uuid, reserved), stamp.part2) }
                    } catch {
                        // Text registration takes priority when the table is full.
                    }
                }
            }
        }
    }

    if (!bb) {
        base.blocks.push({
            ...ob,
            blockId: remap(ob.blockId),
            textItems: ob.textItems.map(remapItem),
            text: { ...ob.text, styles: remapStyles(ob.text.styles) },
            ...(ob.widthData ? {
                widthData: {
                    ...ob.widthData,
                    ...(sourceWidth ? {
                        legacy: incomingWidth ? ob.widthData.legacy : ob.text.width,
                        register: incomingWidth ?? { timestamp: ZERO, value: 0, extraData: sourceWidth.extraData },
                    } : {}),
                },
            } : {}),
        } as RootTextBlock)
        reindex(base.rootTextBlock!)
        return
    }

    if (incomingWidth) {
        const changed = (currentWidth?.value ?? 0) !== incomingWidth.value
        bb.widthData = {
            legacy: changed ? incomingWidth.value : (bb.widthData?.legacy ?? bb.text.width),
            register: { ...incomingWidth, extraData: currentWidth?.extraData ?? EMPTY },
            extraData: bb.widthData?.extraData ?? EMPTY,
        }
        if (changed) {
            bb.text.width = effectiveRootTextWidth(bb.widthData.legacy, incomingWidth.value)
            bb.text.posX = -incomingWidth.value / 2
            bb.text.posY = 234
        }
    }

    // RUN-PRESERVING union (device-verified requirement): xochitl integrates
    // run items with refs into other runs' implicit ids, but a fully
    // per-char item soup makes every character a competing sibling and the
    // device dumps late inserts at the END. So: keep base's runs untouched,
    // append `other`'s runs whose chars base has never seen, split down to
    // chars only for partially-known runs, and route deletions through
    // deleteText (which splits runs the same way the device does).
    const baseState = new Map<string, boolean>() // char id -> deleted?
    for (const item of bb.textItems) {
        for (const c of expandItem(item as CrdtSequenceItem<string | number>)) {
            baseState.set(crdtIdKey(c.itemId), (c.deletedLength ?? 0) > 0)
        }
    }
    // RE-CLOCK (device-verified): xochitl integrates an item at its refs
    // only when its clock dominates the file's global max — concurrent
    // forks mint overlapping clocks, and the loser's text lands appended at
    // the END of the page. New items whose clock is not past the merged
    // max are re-minted at fresh clocks; every intra-batch reference and
    // style key follows through clockMap. Content-dedup keeps a
    // republished identical edit from duplicating despite fresh ids.
    let clockMax = base.maxClock()
    const clockMap = new Map<string, CrdtId>()
    const followClock = (id: CrdtId): CrdtId => clockMap.get(crdtIdKey(id)) ?? id
    const existingShape = new Set(
        bb.textItems.map(
            (i) =>
                `${i.itemId.part1}|${crdtIdKey(i.leftId)}|${crdtIdKey(i.rightId)}|${i.deletedLength}|${JSON.stringify(i.value ?? null)}`,
        ),
    )
    const toDelete: CrdtId[] = []
    for (const rawItem of ob.textItems) {
        let item = remapItem(rawItem)
        item = { ...item, leftId: followClock(item.leftId), rightId: followClock(item.rightId) }
        const chars = [...expandItem(item as CrdtSequenceItem<string | number>)]
        const unseen = chars.filter((c) => !baseState.has(crdtIdKey(c.itemId)))
        if (unseen.length === chars.length) {
            const shape = `${item.itemId.part1}|${crdtIdKey(item.leftId)}|${crdtIdKey(item.rightId)}|${item.deletedLength}|${JSON.stringify(item.value ?? null)}`
            if (existingShape.has(shape)) continue // republished identical edit
            const span =
                item.deletedLength > 0
                    ? item.deletedLength
                    : typeof item.value === 'string'
                      ? Math.max(1, [...item.value].length)
                      : 1
            if (item.itemId.part2 <= clockMax) {
                const fresh = crdtId(item.itemId.part1, clockMax + 1)
                for (let j = 0; j < span; j++) {
                    clockMap.set(
                        crdtIdKey(crdtId(item.itemId.part1, item.itemId.part2 + j)),
                        crdtId(fresh.part1, fresh.part2 + j),
                    )
                }
                item = { ...item, itemId: fresh }
            }
            clockMax = Math.max(clockMax, item.itemId.part2 + span - 1)
            bb.textItems.push(item)
            existingShape.add(shape)
            continue
        }
        for (const c of chars) {
            const key = crdtIdKey(c.itemId)
            const known = baseState.get(key)
            if (known === undefined) {
                bb.textItems.push(c as TextItem) // rare: partially-known run
            } else if ((c.deletedLength ?? 0) > 0 && known === false) {
                toDelete.push(c.itemId) // deleted wins, via run-splitting
            }
        }
    }
    if (toDelete.length > 0) {
        reindex(bb)
        deleteTextFromBlock(bb, toDelete)
    }
    const mergedAuthors = base.authorTable()
    for (const [rawKey, style] of ob.text.styles) {
        const [kp1, kp2] = rawKey.split(':').map(Number)
        const key = crdtIdKey(followClock(remap(crdtId(kp1!, kp2!))))
        const current = bb.text.styles.get(key)
        if (!current || textRegisterWins(style.timestamp, current.timestamp, otherAuthors, mergedAuthors)) {
            bb.text.styles.set(key, { ...style, timestamp: remap(style.timestamp) })
        }
    }
    reindex(bb)
}

/** A minimal, multi-region text diff for turning an old string into a new one
 *  as CRDT edits. `deletes` are code-point indices INTO `a` to tombstone;
 *  each insert places `text` immediately after code-point index `after` of `a`
 *  (`after === -1` = at the very start). Regions are separated by surviving
 *  (unchanged) code points, so every `after` refers to a code point that is NOT
 *  in `deletes` — a stable anchor. */
export interface CodePointDiff {
    deletes: number[]
    inserts: { after: number; text: string }[]
}

/**
 * Diff two code-point arrays (astral-safe: pass `[...str]`, not the raw string)
 * into the minimal set of delete/insert regions via Myers' O(ND) algorithm —
 * cost scales with the number of DIFFERENCES, not the text length, so a typo
 * fix on a long paragraph is cheap. Unchanged characters (including '\n'
 * separators that anchor paragraph styles and handwriting) stay matched and
 * untouched, so editing two non-adjacent lines doesn't tombstone the
 * untouched line's '\n'. If the edit distance exceeds `maxD`, falls back to
 * a single replace-the-changed-span region: always correct, just not minimal.
 */
export function diffCodePoints(a: string[], b: string[], maxD = 3000): CodePointDiff {
    // Trim the common prefix/suffix first: those code points stay matched, and
    // it shrinks the Myers problem to just the changed span in the common case.
    let start = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start++
    let ea = a.length
    let eb = b.length
    while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) {
        ea--
        eb--
    }
    const am = a.slice(start, ea)
    const bm = b.slice(start, eb)

    const script = myersScript(am, bm, maxD)
    const deletes: number[] = []
    const inserts: { after: number; text: string }[] = []
    if (!script) {
        // Fallback: replace the whole changed span as one region. `start - 1` is
        // the last matched prefix code point (a stable survivor), or -1.
        for (let i = start; i < ea; i++) deletes.push(i)
        if (bm.length) inserts.push({ after: start - 1, text: bm.join('') })
        return { deletes, inserts }
    }

    let lastKept = start - 1 // survivor to the left; -1 => insert at the start
    let curIns: { after: number; text: string } | null = null
    let ai = 0
    let bi = 0
    for (const op of script) {
        if (op === 0) {
            // keep: this code point survives and anchors any following insert
            lastKept = start + ai
            ai++
            bi++
            curIns = null
        } else if (op === -1) {
            // delete a[start+ai]; deletes never split an insert run (the
            // inserted run is contiguous in `b` between two kept code points)
            deletes.push(start + ai)
            ai++
        } else {
            // insert b[start+bi], grouped into one region per gap
            if (!curIns) {
                curIns = { after: lastKept, text: '' }
                inserts.push(curIns)
            }
            curIns.text += bm[bi]!
            bi++
        }
    }
    return { deletes, inserts }
}

/** Myers shortest-edit-script: returns ops in order (0 = keep, -1 = delete from
 *  `a`, 1 = insert from `b`), or null if the edit distance exceeds `maxD`. */
function myersScript(a: string[], b: string[], maxD: number): number[] | null {
    const n = a.length
    const m = b.length
    if (n === 0 && m === 0) return []
    const maxSteps = Math.min(maxD, n + m)
    const offset = n + m
    const v = new Int32Array(2 * (n + m) + 1)
    const trace: Int32Array[] = []
    let foundD = -1
    for (let d = 0; d <= maxSteps; d++) {
        trace.push(v.slice())
        for (let k = -d; k <= d; k += 2) {
            let x: number
            if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
                x = v[offset + k + 1]! // down = insert b
            } else {
                x = v[offset + k - 1]! + 1 // right = delete a
            }
            let y = x - k
            while (x < n && y < m && a[x] === b[y]) {
                x++
                y++
            }
            v[offset + k] = x
            if (x >= n && y >= m) {
                foundD = d
                break
            }
        }
        if (foundD >= 0) break
    }
    if (foundD < 0) return null

    // Backtrack from (n,m) to (0,0), emitting ops; reverse at the end.
    const ops: number[] = []
    let x = n
    let y = m
    for (let d = foundD; d > 0; d--) {
        const vPrev = trace[d]!
        const k = x - y
        let prevK: number
        if (k === -d || (k !== d && vPrev[offset + k - 1]! < vPrev[offset + k + 1]!)) {
            prevK = k + 1 // came from a down move (insert)
        } else {
            prevK = k - 1 // came from a right move (delete)
        }
        const prevX = vPrev[offset + prevK]!
        const prevY = prevX - prevK
        while (x > prevX && y > prevY) {
            ops.push(0) // diagonal snake = keep
            x--
            y--
        }
        if (x === prevX) {
            ops.push(1) // insert
            y--
        } else {
            ops.push(-1) // delete
            x--
        }
    }
    while (x > 0 && y > 0) {
        ops.push(0)
        x--
        y--
    }
    ops.reverse()
    return ops
}
