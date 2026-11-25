/**
 * The device bridge core.
 *
 * The tablet daemon is codec-dumb and speaks whole-`.rm` blobs; web clients
 * speak commutative ops. The cloud (which has the codec) bridges the two for the
 * device peer — running the merge engine SERVER-SIDE for that one peer while web
 * clients still merge client-side:
 *
 *   - reconstructRm(snapshot, ops)  — materialize the current `.rm` from the op
 *     log so the daemon can push it to xochitl (the daemon's GET /rm).
 *   - diffToOps(prevRm, nextRm)     — turn xochitl's merged `.rm` (the daemon's
 *     PUT /rm) back into the deltas it introduced, to append to the op log.
 *
 * Both are pure. Because every `.rm` item carries a stable CRDT id, a round-trip
 * (ops → reconstruct → xochitl merge → diff → ops) never re-adds or duplicates
 * web items: they keep their ids on both sides, so the diff only surfaces the
 * NEW tablet items (and tombstones xochitl made).
 */

import { RmDocument, mergeRootTextInto, rootTextUnresolvedMergeSlots, type CrdtId, type SceneLineItemBlock } from '@weft/rm-format'
import {
    applyInkDeltas,
    idToOpRef,
    deadLineBlockToAddOp,
    lineBlockToAddOp,
    type AddItemOp,
    type Op,
    type TombstoneOp,
} from './ops'

/** Materialize the current `.rm` bytes from a snapshot (its `.rm` layer, or an
 *  empty doc) plus the ink ops layered after it. Non-ink ops (overlay objects)
 *  are ignored — they don't belong in the device `.rm`. `authorUuid` seeds the
 *  empty doc when there's no snapshot. */
export function reconstructRm(
    snapshotRm: Uint8Array | null,
    ops: Op[],
    authorUuid: string,
): Uint8Array {
    const doc = snapshotRm ? RmDocument.parse(snapshotRm) : RmDocument.empty(authorUuid)
    const inkOps = ops.filter((o): o is AddItemOp | TombstoneOp => o.op === 'add' || o.op === 'tombstone')
    if (snapshotRm && inkOps.length === 0) return snapshotRm.slice()
    applyInkDeltas(doc, inkOps)
    return doc.serialize()
}

interface LineState {
    block: SceneLineItemBlock
    dead: boolean
}

/** Index a doc's scene LINE items by portable id key. */
function lineItems(doc: RmDocument): Map<string, LineState> {
    const out = new Map<string, LineState>()
    for (const b of doc.blocks) {
        if (b.type !== 'sceneLineItem') continue
        const block = b as SceneLineItemBlock
        const ref = idToOpRef(doc, block.itemId)
        out.set(`${ref.author ?? 'sys'}:${ref.clock}`, {
            block,
            dead: block.deletedLength > 0,
        })
    }
    return out
}

/** Portable-id keys of glyph/image items — the bridge does NOT diff these. */
function unsupportedKeys(doc: RmDocument): Set<string> {
    const out = new Set<string>()
    for (const b of doc.blocks) {
        if (b.type !== 'sceneGlyphItem' && b.type !== 'sceneImageItem') continue
        const ref = idToOpRef(doc, (b as unknown as { itemId: CrdtId }).itemId)
        out.add(`${ref.author ?? 'sys'}:${ref.clock}`)
    }
    return out
}

/**
 * Stable fingerprint of everything the LINE diff cannot represent: the root
 * TEXT (items, styles, position), the scene-tree structure (tree edges,
 * group items) and treeNode metadata including text ANCHORS. If any of it
 * changed between prev and next, the op diff is incomplete and the caller
 * must snapshot — before this existed, a tablet TEXT edit on an op-mode
 * page produced zero ops, `complete: true`, no snapshot, and the next
 * reconstruction silently reverted the tablet's typing.
 */
function structureFingerprint(doc: RmDocument): string {
    const k = (id: CrdtId | null | undefined) => (id ? `${id.part1}:${id.part2}` : '-')
    const parts: string[] = []
    const authors = doc.authorTable()
    for (const b of doc.blocks) {
        switch (b.type) {
            case 'rootText': {
                for (const it of b.textItems) {
                    parts.push(
                        `t ${k(it.itemId)} ${k(it.leftId)} ${k(it.rightId)} ${it.deletedLength} ${JSON.stringify(it.value ?? null)}`,
                    )
                }
                const styles = [...b.text.styles.entries()].sort((a, z) => (a[0] < z[0] ? -1 : 1))
                for (const [key, sv] of styles) parts.push(`s ${key} ${k(sv.timestamp)} ${sv.value}`)
                parts.push(`p ${b.text.posX} ${b.text.posY} ${b.text.width}`)
                const width = b.widthData?.register
                if (width) {
                    const slot = width.timestamp.part1
                    const author = slot === 0 ? 'sys' : (authors.get(slot)?.toLowerCase() ?? k(width.timestamp))
                    parts.push(`w ${author} ${width.timestamp.part2} ${width.value}`)
                }
                break
            }
            case 'treeNode':
                parts.push(
                    `n ${k(b.nodeId)} ${JSON.stringify(b.label.value)} ${b.visible.value} ` +
                        `${b.anchorId ? k(b.anchorId.value) : '-'} ${b.anchorOriginX?.value ?? '-'}`,
                )
                break
            case 'sceneTree':
                parts.push(`e ${k(b.treeId)} ${k(b.nodeId)} ${k(b.parentId)}`)
                break
            case 'sceneGroupItem':
                parts.push(`g ${k(b.itemId)} ${k(b.parentId)} ${k(b.nodeId)} ${b.deletedLength}`)
                break
            // Glyph/image items are not line-diffed either, and the key-set
            // check above only catches NEW ids: a live->dead flip or an
            // in-place value change (image re-placement) kept `complete`
            // true and silently reverted the tablet's edit on the next
            // reconstruction — the same class as the root-text hole this
            // fingerprint exists to close.
            case 'sceneGlyphItem':
                parts.push(
                    `y ${k(b.itemId)} ${b.deletedLength} ` +
                        (b.glyph
                            ? `${b.glyph.start ?? '-'} ${b.glyph.length} ${b.glyph.color} ${JSON.stringify(b.glyph.text ?? '')}`
                            : '-'),
                )
                break
            case 'sceneImageItem':
                parts.push(
                    `im ${k(b.itemId)} ${b.deletedLength} ` +
                        (b.image
                            ? `${b.image.vertices.map((v) => Math.fround(v)).join(',')} ${b.image.filename ?? '-'}`
                            : '-'),
                )
                break
        }
    }
    return parts.sort().join('\n')
}

export interface DiffResult {
    ops: Op[]
    /**
     * False when `next` introduces items the op diff can't represent — new
     * glyph (typed text) or image items the tablet created that aren't in
     * `prev`. The caller MUST then publish a full snapshot instead of trusting
     * these ops alone, so the op channel can't silently drop on-device typed
     * text / images (mirrors applyOps's `complete`). True ⇒ the ops fully
     * capture the change.
     */
    complete: boolean
}

/**
 * Diff two `.rm` documents into the ops that turn `prev` into `next`:
 *   - a live line item present in `next` but absent in `prev`  -> addItem
 *   - an item live in `prev` but tombstoned in `next`          -> tombstone
 *
 * Items present (with the same PORTABLE id) in both are untouched — this is what
 * keeps a round-trip idempotent: web items the daemon merely carried through
 * keep their ids and produce no ops. `prev` is the cloud's reconstructed current
 * state; `next` is xochitl's freshly-merged file from the daemon's PUT.
 *
 * Scope: only `sceneLineItem` is diffed. New glyph/image items (typed text,
 * images created on the tablet) are NOT representable as line deltas yet, so
 * `complete` goes false and the caller snapshots — they are never silently
 * dropped (see §13).
 */
export function diffToOps(prevRm: Uint8Array | null, nextRm: Uint8Array): DiffResult {
    return diffDocuments(prevRm ? RmDocument.parse(prevRm) : null, RmDocument.parse(nextRm))
}

function diffDocuments(prevDoc: RmDocument | null, nextDoc: RmDocument): DiffResult {
    const prev = prevDoc ? lineItems(prevDoc) : new Map<string, LineState>()
    const next = lineItems(nextDoc)
    const ops: Op[] = []
    for (const [key, state] of next) {
        const before = prev.get(key)
        if (!before) {
            // brand-new item. If it arrived already-dead (drawn+erased between
            // pushes), emit add then tombstone so peers converge to dead.
            // xochitl drops the value on erase, so the dead block is usually
            // VALUELESS — a lone tombstone can't materialize it on a replica
            // (the block, hence the bytes, went missing: 2026-07-16 finding
            // on a real mid-storm snapshot pair), so a header-only add rides
            // along and the pair reproduces the dead block byte-exactly.
            if (!state.dead && state.block.line) {
                ops.push(lineBlockToAddOp(nextDoc, state.block))
            } else if (state.dead) {
                ops.push(
                    state.block.line
                        ? lineBlockToAddOp(nextDoc, state.block)
                        : deadLineBlockToAddOp(nextDoc, state.block),
                )
                ops.push({ op: 'tombstone', id: idToOpRef(nextDoc, state.block.itemId) })
            }
        } else if (!before.dead && state.dead) {
            // xochitl erased an item we already knew live
            ops.push({ op: 'tombstone', id: idToOpRef(nextDoc, state.block.itemId) })
        }
    }
    // Anything the LINE diff can't represent must flag incompleteness so
    // the caller snapshots instead of dropping it: new glyph/image items,
    // AND any change to the root text / scene-tree structure / anchors.
    const prevUnsupported = prevDoc ? unsupportedKeys(prevDoc) : new Set<string>()
    let complete = true
    for (const key of unsupportedKeys(nextDoc)) {
        if (!prevUnsupported.has(key)) {
            complete = false
            break
        }
    }
    if (complete) {
        const prevFp = prevDoc ? structureFingerprint(prevDoc) : ''
        if (structureFingerprint(nextDoc) !== prevFp) complete = false
    }
    return { ops, complete }
}

/**
 * Tombstones for strokes the CLOUD has live but the tablet (authoritative for
 * its own ink) no longer has AT ALL. xochitl's undo removes a block outright
 * (not a tombstone), so diffToOps never saw the deletion and the stroke lived
 * on in the cloud forever, so the tablet and cloud never converged.
 *
 * Deciding "absence = deletion" has two regimes, best first:
 *
 *  - CAUSAL BASE (`causalBaseRm`, the reconstruction at the daemon's
 *    x-base-revision — the exact state its file descends from): an item is a
 *    device deletion iff it was LIVE AT THE BASE and is absent from the
 *    device file. Items the cloud gained after the base (concurrent web ink,
 *    a revert resurrecting old-clock items, a late-flushed op from another
 *    session of the same author) are never touched. This is exact — no
 *    inference.
 *  - VERSION VECTOR (fallback when the base can't be reconstructed, e.g. its
 *    snapshot was pruned): the tablet has SEEN past this item's clock for its
 *    author, so its absence is treated as observed-and-removed. Heuristic: a
 *    same-author item that arrives out of clock order (two sessions sharing
 *    an author id, or a revert) can be falsely tombstoned — which is exactly
 *    why the causal base is preferred.
 *
 * USE ONLY in the device-authoritative direction (deviceRm is the source of
 * truth) — never to reconcile two peers, where absence is ambiguous.
 */
export function deviceRemovedTombstones(
    cloudRm: Uint8Array | null,
    deviceRm: Uint8Array,
    causalBaseRm?: Uint8Array | null,
): TombstoneOp[] {
    if (!cloudRm) return []
    const cloudDoc = RmDocument.parse(cloudRm)
    const deviceDoc = RmDocument.parse(deviceRm)
    const cloud = lineItems(cloudDoc)
    const device = lineItems(deviceDoc)
    if (causalBaseRm) {
        // keys lowercased throughout this branch: base, cloud and device files
        // may register the same author uuid with different casing in their
        // author tables, and a case mismatch here would fabricate a tombstone
        const liveAtBase = liveLineKeys(causalBaseRm)
        const onDevice = new Set([...device.keys()].map((k) => k.toLowerCase()))
        const out: TombstoneOp[] = []
        for (const [key, state] of cloud) {
            if (state.dead || !state.block.line || onDevice.has(key.toLowerCase())) continue
            if (liveAtBase.has(key.toLowerCase())) {
                out.push({ op: 'tombstone', id: idToOpRef(cloudDoc, state.block.itemId) })
            }
        }
        return out
    }
    const seen = deviceSeenClocks(deviceDoc)
    const out: TombstoneOp[] = []
    for (const [key, state] of cloud) {
        if (state.dead || !state.block.line || device.has(key)) continue
        const ref = idToOpRef(cloudDoc, state.block.itemId)
        const a = ref.author?.toLowerCase()
        if (!a) continue
        const max = seen.get(a)
        if (max !== undefined && ref.clock <= max) out.push({ op: 'tombstone', id: ref })
    }
    return out
}

/** Per-author max clock observed anywhere in a device file (anchor sentinels
 *  excluded) — the version vector both fallback paths share. */
function deviceSeenClocks(deviceDoc: RmDocument): Map<string, number> {
    const seen = new Map<string, number>()
    const SENTINEL = 2 ** 48
    for (const b of deviceDoc.blocks) {
        const id = (b as { itemId?: CrdtId }).itemId
        if (!id || id.part1 === 0 || id.part2 >= SENTINEL) continue
        const uuid = deviceDoc.authorTable().get(id.part1)?.toLowerCase()
        if (!uuid) continue
        if (id.part2 > (seen.get(uuid) ?? 0)) seen.set(uuid, id.part2)
    }
    return seen
}

/**
 * How to interpret an item that the PUBLISHER's file lacks entirely:
 *  - 'never': the publisher keeps tombstones for everything it deletes (our
 *    web client), so absence only ever means "never seen" — always re-add.
 *  - {base}: absence is a deletion iff the item was LIVE in the exact state
 *    the publisher's file descends from (the daemon's x-base-revision
 *    reconstruction) — exact, never drops a late-flushed or revert-restored
 *    item.
 *  - 'vector': legacy per-author max-clock heuristic (fallback when the base
 *    cannot be rebuilt); can falsely treat out-of-clock-order arrivals as
 *    deletions.
 */
export type AbsencePolicy = 'never' | 'vector' | { baseRm: Uint8Array }

/** Lowercased `${authorUuid}:${clock}` keys of LIVE line items — author
 *  tables may register the same uuid with different casing across files. */
function liveLineKeys(rm: Uint8Array): Set<string> {
    return new Set(
        [...lineItems(RmDocument.parse(rm))]
            .filter(([, s]) => !s.dead)
            .map(([k]) => k.toLowerCase()),
    )
}

/**
 * Does `cloudRm` hold content that `pusherRm` lacks? Backs the `merged` flag:
 * a pusher whose file misses any of the stored state must pull it back or its
 * replica silently diverges. Three superset signals:
 *  - items live in cloud but ABSENT from the pusher (diffToOps add ops),
 *  - structure/text differences (diffToOps fingerprint incompleteness),
 *  - items live in cloud but TOMBSTONED in the pusher — the restore case: a
 *    web revert resurrects an item the device still carries as dead; the
 *    plain diff is blind to dead→live, and without this signal the device
 *    would never learn its deletion was overridden.
 */
export function contentBeyond(pusherRm: Uint8Array, cloudRm: Uint8Array): boolean {
    const pusherDoc = RmDocument.parse(pusherRm)
    const cloudDoc = RmDocument.parse(cloudRm)
    const back = diffDocuments(pusherDoc, cloudDoc)
    if (back.ops.length > 0 || !back.complete) return true
    const pusher = lineItems(pusherDoc)
    const pusherDead = new Set(
        [...pusher].filter(([, s]) => s.dead).map(([k]) => k.toLowerCase()),
    )
    for (const [key, s] of lineItems(cloudDoc)) {
        if (!s.dead && s.block.line && pusherDead.has(key.toLowerCase())) return true
    }
    return false
}

/**
 * Every line item in `deviceRm` reproduced value-faithfully (verbatim points,
 * liveness, refs) in `reconRm`. The runtime byte-equality guard's
 * discriminator: a sha mismatch with all device items reproduced is the cloud
 * holding EXTRA content (web edits the tablet hasn't pulled — intended, the
 * merged pullback delivers it); any device item missing or altered is a diff
 * vocabulary gap that must demote the push to a snapshot.
 */
export function deviceLinesReproduced(deviceRm: Uint8Array, reconRm: Uint8Array): boolean {
    const dev = RmDocument.parse(deviceRm)
    const rec = RmDocument.parse(reconRm)
    const proj = (d: RmDocument, b: SceneLineItemBlock) =>
        JSON.stringify({
            dead: b.deletedLength,
            parent: idToOpRef(d, b.parentId),
            left: idToOpRef(d, b.leftId),
            right: idToOpRef(d, b.rightId),
            line: b.line
                ? {
                      tool: b.line.tool,
                      color: b.line.color,
                      thicknessScale: b.line.thicknessScale,
                      startingLength: b.line.startingLength,
                      timestamp: idToOpRef(d, b.line.timestamp),
                      moveId: b.line.moveId ? idToOpRef(d, b.line.moveId) : null,
                      points: b.line.points,
                  }
                : null,
        })
    const keyOf = (d: RmDocument, id: CrdtId) => {
        const r = idToOpRef(d, id)
        return `${r.author ?? 'sys'}:${r.clock}`
    }
    const got = new Map<string, string>()
    for (const b of rec.blocks) {
        if (b.type !== 'sceneLineItem') continue
        const blk = b as SceneLineItemBlock
        got.set(keyOf(rec, blk.itemId), proj(rec, blk))
    }
    for (const b of dev.blocks) {
        if (b.type !== 'sceneLineItem') continue
        const blk = b as SceneLineItemBlock
        if (got.get(keyOf(dev, blk.itemId)) !== proj(dev, blk)) return false
    }
    return true
}

/**
 * Gate the EXPLICIT tombstones a device diff produced by the causal base: a
 * dead item in the device file whose id was already dead (or absent) at the
 * device's base is OLD NEWS it merely carried through — not a new deletion.
 * Emitting it anyway would re-kill an item a later event (a web restore)
 * resurrected. Items live at the base were observed-live and killed on the
 * device: those deletions are real and pass through. No base: pass all
 * (legacy behavior).
 */
export function gateTombstonesByBase(ops: Op[], causalBaseRm: Uint8Array | null): Op[] {
    if (!causalBaseRm) return ops
    const liveAtBase = liveLineKeys(causalBaseRm)
    const keyOf = (id: { author?: string | null; clock: number }) =>
        `${id.author?.toLowerCase() ?? 'sys'}:${id.clock}`
    // A brand-new-dead PAIR (add+tombstone, id unknown at base) passes
    // through whole: it is a new deletion of new content, and no web restore
    // can reference an id the cloud never saw. Dropping the pair as
    // "render-identical to absent" (pre-2026-07-16) broke BYTE equality —
    // the device file keeps the valueless dead block, the reconstruction
    // lacked it, and the daemon's sha-compare rewrote the page under the
    // pen. Only a LONE tombstone for an id not live at base is old news the
    // device carried through — dropping it is what protects a web restore.
    const paired = new Set<string>()
    for (const o of ops) {
        if (o.op === 'add') paired.add(keyOf(o.id))
    }
    return ops.filter((o) => {
        if (o.op === 'tombstone') return liveAtBase.has(keyOf(o.id)) || paired.has(keyOf(o.id))
        return true
    })
}

/**
 * CRDT-merge for snapshot publication: union `other` (the server's current
 * reconstruction — edits the publisher may not have seen) INTO `base` (the
 * incoming bytes). Ink unions by item id with deleted-wins (via the same
 * diff the device path uses); root text unions per character id with
 * deleted-wins and LWW styles; the publisher's tree/anchor structure wins.
 * Lines whose parent group does not exist in `base` reparent to the first
 * layer instead of orphaning invisibly.
 *
 * Before this existed a snapshot stored the publisher's bytes VERBATIM: a
 * web edit landing between the tablet's pull and push (or tablet typing
 * landing before a web snapshot) was silently clobbered.
 */
export function mergeForSnapshot(
    baseRm: Uint8Array,
    otherRm: Uint8Array | null,
    absence: AbsencePolicy = 'vector',
): Uint8Array {
    if (!otherRm || (baseRm.length === otherRm.length && baseRm.every((byte, i) => byte === otherRm[i]))) return baseRm
    const baseDoc = RmDocument.parse(baseRm)
    const otherDoc = RmDocument.parse(otherRm)
    rootTextUnresolvedMergeSlots(baseDoc, otherDoc)
    const { ops } = diffDocuments(baseDoc, otherDoc)
    if (ops.length > 0) {
        // The union re-adds strokes `otherRm` has that `baseRm` lacks, to protect
        // CONCURRENT edits the base hasn't pulled yet. But "absent" is ambiguous:
        // a stroke the publisher AUTHORED and then DELETED (xochitl's undo
        // removes the block outright) is also absent — re-adding it resurrects
        // a phantom. The AbsencePolicy decides.
        const liveAtBase =
            typeof absence === 'object' ? liveLineKeys(absence.baseRm) : null
        const seen = absence === 'vector' ? deviceSeenClocks(baseDoc) : null
        const inkOps = ops
            .filter((o): o is AddItemOp | TombstoneOp => o.op === 'add' || o.op === 'tombstone')
            .filter((o) => {
                if (o.op === 'tombstone') return true // deletions always apply
                if (absence === 'never') return true // absence = unseen: re-add
                const a = o.id.author?.toLowerCase()
                if (!a) return true // system author: keep
                if (liveAtBase) return !liveAtBase.has(`${a}:${o.id.clock}`)
                const max = seen!.get(a)
                return max === undefined || o.id.clock > max
            })
        applyInkDeltas(baseDoc, inkOps)
        // reparent lines whose group does not exist here
        const validParents = new Set<string>()
        for (const b of baseDoc.blocks) {
            if (b.type === 'sceneGroupItem' && b.nodeId) {
                validParents.add(`${b.nodeId.part1}:${b.nodeId.part2}`)
            }
        }
        validParents.add('0:1')
        const firstLayer = baseDoc.layers()[0]?.nodeId
        if (firstLayer) {
            for (const b of baseDoc.blocks) {
                if (b.type !== 'sceneLineItem') continue
                const key = `${b.parentId.part1}:${b.parentId.part2}`
                if (!validParents.has(key)) b.parentId = firstLayer
            }
        }
    }
    mergeRootTextInto(baseDoc, otherDoc)
    return baseDoc.serialize()
}

/**
 * CLONE COLLISION quarantine: two devices restored from the same xochitl
 * backup share an author uuid AND continue
 * the same global Lamport counter, so two DIFFERENT concurrently-drawn
 * strokes can carry the SAME (author, clock) id. The portable key then
 * aliases them: diffToOps sees "already present" and silently drops one
 * stroke, and the page never converges.
 *
 * Before diffing, re-key any live device item whose id collides with a
 * DIFFERENT-geometry live cloud item to a fresh clock (above both files'
 * maxima), fixing up sibling leftId/rightId references. The device pulls
 * the union back (its file is regenerated from cloud ops), so the re-key
 * sticks and later pushes are collision-free.
 */
export function rekeyCloneCollisions(
    cloudRm: Uint8Array | null,
    deviceRm: Uint8Array,
): { bytes: Uint8Array; rekeyed: number } {
    if (!cloudRm) return { bytes: deviceRm, rekeyed: 0 }
    const cloudDoc = RmDocument.parse(cloudRm)
    const deviceDoc = RmDocument.parse(deviceRm)
    const cloud = lineItems(cloudDoc)
    const device = lineItems(deviceDoc)

    // float32-quantized: the .rm stores float32, so any float64-precision
    // writer upstream (op payloads, merges) must not make a stroke look like
    // a clone of itself. Exact-string comparison of float64 values did
    // exactly that once (2026-07-14: rounded op copies vs device floats
    // re-keyed every stroke on every push, rewriting pages under the pen).
    const geoOf = ({ block }: LineState) => {
        const v1 = block.version.current === 1
        return block.line?.points.map((p) => {
            // Match the historic width quantization used by portable v2 replay.
            const width = v1 ? Math.round(p.width) : p.width
            return `${Math.fround(p.x)},${Math.fround(p.y)},${width}`
        }).join(';') ?? ''
    }
    const collisions: { old: CrdtId }[] = []
    for (const [key, state] of device) {
        if (state.dead || !state.block.line) continue
        const other = cloud.get(key)
        if (!other || other.dead || !other.block.line) continue
        if (geoOf(state) !== geoOf(other)) collisions.push({ old: state.block.itemId })
    }
    if (collisions.length === 0) return { bytes: deviceRm, rekeyed: 0 }

    let nextClock = Math.max(cloudDoc.maxClock(), deviceDoc.maxClock())
    const SENTINEL = 2 ** 48
    const eq = (a: CrdtId, b: CrdtId) => a.part1 === b.part1 && a.part2 === b.part2
    for (const { old } of collisions) {
        nextClock += 1
        if (nextClock >= SENTINEL) break // never mint anchor-sentinel clocks
        const fresh = { part1: old.part1, part2: nextClock }
        for (const b of deviceDoc.blocks) {
            const blk = b as unknown as {
                itemId?: CrdtId
                leftId?: CrdtId
                rightId?: CrdtId
            }
            if (blk.itemId && eq(blk.itemId, old)) blk.itemId = fresh
            if (blk.leftId && eq(blk.leftId, old)) blk.leftId = fresh
            if (blk.rightId && eq(blk.rightId, old)) blk.rightId = fresh
        }
    }
    return { bytes: deviceDoc.serialize(), rekeyed: collisions.length }
}
