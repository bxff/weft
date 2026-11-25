/**
 * Apply local entity ops to a document + overlay pair. Pure with respect to
 * inputs (mutates the passed doc/overlay, which callers clone): the same op
 * list can be re-applied to fresher bytes during a 409 rebase or an offline
 * reconcile — ops describe intent, not byte positions.
 */

import {
    RmDocument,
    Pen,
    crdtId,
    crdtIdKey,
    lww,
    uuidToBytesLE,
    createRootText,
    insertText,
    insertFormatCode,
    deleteText,
    setParagraphStyle,
    type CrdtId,
    type Point,
    type Line,
    type SceneLineItemBlock,
} from '@weft/rm-format'
import { tldrawColorToPenColor, type InkStroke } from '@weft/rm-ink/pure'
import { RefResolver } from './refs'
import { compareVersion, currentObjectVersion, idToOpRef, lineBlockToAddOp, mergeBrowserOrder, mergeShapeOpacity, type Op } from './ops'
import type { ItemRef, OpVersion, OverlayDocument, OverlayShape, RenderedPart } from './types'

export interface ProjectedPart {
    partKey: string
    strokes: InkStroke[]
}

/** Stable cross-file layer address: author 0 (system) has no uuid. */
export interface LayerRef {
    authorUuid: string | null
    clock: number
}

export function layerRefToId(doc: RmDocument, ref: LayerRef): CrdtId | null {
    if (ref.authorUuid === null) return crdtId(0, ref.clock)
    for (const [index, uuid] of doc.authorTable()) {
        if (uuid.toLowerCase() === ref.authorUuid.toLowerCase()) return crdtId(index, ref.clock)
    }
    return null
}

export function layerIdToRef(doc: RmDocument, id: CrdtId): LayerRef {
    if (id.part1 === 0) return { authorUuid: null, clock: id.part2 }
    const uuid = doc.authorTable().get(id.part1)
    return { authorUuid: uuid?.toLowerCase() ?? null, clock: id.part2 }
}

export type LocalOp =
    | {
          type: 'upsert-shape'
          /** `version` (inside `shape`) is stamped by the producer at edit-
           *  capture (wall-clock ms + clientId, D7) and reproduced verbatim onto
           *  the delta, so the edit-time timestamp survives rebase/replay (never
           *  the later apply time). */
          shape: Omit<OverlayShape, 'rendered' | 'state'>
          parts: ProjectedPart[]
          /** Target layer; omitted = the document's default (first) layer. */
          layer?: LayerRef
      }
    | { type: 'set-browser-index'; shapeId: string; from?: string; index: string; version: OpVersion }
    | { type: 'remove-shape'; shapeId: string; version: OpVersion }
    | {
          /** Detached resolution: forget the overlay shape but KEEP its
           *  surviving strokes on the page as plain ink. */
          type: 'release-shape'
          shapeId: string
          version: OpVersion
      }
    | { type: 'remove-ink'; items: ItemRef[] }
    | {
          /** Native move: offset original samples for a translation, or use
           * baked points for a general transform. Both use native page units. */
          type: 'transform-ink'
          items: { ref: ItemRef; points: Point[]; translation?: { x: number; y: number } }[]
      }
    | { type: 'create-layer'; label: string }
    | { type: 'set-layer-visible'; layer: LayerRef; visible: boolean }
    | {
          /** Insert an embedded image. The caller uploads the asset
           *  bytes to <doc>/<page>/<filename> BEFORE applying (the op only
           *  writes the .rm registry + placement). */
          type: 'insert-image'
          /** Canonical uuid string naming the asset. */
          assetUuid: string
          /** e.g. `${assetUuid}.png` — must exist in the page asset dir. */
          filename: string
          /** 4 corners x (x, y, u, v), ink units. */
          vertices: number[]
          /** Target layer; omitted = the document's default (first) layer. */
          layer?: LayerRef
      }
    | {
          /** Move/resize an embedded image: tombstone + re-append with new
           *  placement — the device-native move pattern (xochitl does the
           *  same; in-place value mutation of a CRDT item is not). */
          type: 'move-image'
          item: ItemRef
          /** 4 corners x (x, y, u, v), ink units. */
          vertices: number[]
      }
    | {
          /** Device typed-text edits (the page's text COLUMN), applied via
           *  the rm-format text CRDT under our author identity. No op-channel
           *  form — snapshot fallback, like layer ops. Char ids travel as
           *  "part1:part2" keys. */
          type: 'edit-root-text'
          /** Create the column first (pages with no text; device defaults). */
          create?: { posX?: number; posY?: number; width?: number }
          /** Either a text run or a chain of inline format codes (1/2 bold
           *  on/off, 3/4 italic on/off) inserted after `afterKey`. */
          inserts?: { afterKey: string | null; text?: string; codes?: number[] }[]
          deleteKeys?: string[]
          /** [anchor char key, ParagraphStyle, wire extra bytes (size /
           *  indent property pairs) or undefined] LWW sets. */
          styles?: [string, number, number[] | undefined][]
      }

export interface ApplyOptions {
    authorUuid: string
    pen?: Pen | undefined
}

/**
 * Result of applying local ops. `deltas` are the commutative,
 * id-anchored CRDT ops the apply minted — ship them on the op channel and
 * replay them (applyInkDeltas + overlay upserts) to reproduce this exact state
 * on any peer. Callers that only want the in-place mutation can ignore it.
 *
 * `complete` is true only when EVERY applied op is fully captured by `deltas`.
 * Image and layer ops have no replayable ink delta yet (InkDeltaApplier rejects
 * image adds; layers have no op form), so when one of those is applied `deltas`
 * omits it and `complete` is false — the caller MUST fall back to a snapshot for
 * convergence rather than trusting the op log alone. This keeps the op log free
 * of un-replayable entries (no partial image move = no orphaned tombstone).
 */
export interface ApplyResult {
    deltas: Op[]
    complete: boolean
}

export function applyOps(
    doc: RmDocument,
    overlay: OverlayDocument,
    ops: LocalOp[],
    opts: ApplyOptions,
): ApplyResult {
    if (ops.length > 1) {
        const existing = new Set(overlay.shapes.map((shape) => shape.shapeId))
        const freshShapes = ops.every((op) => {
            if (op.type !== 'upsert-shape' || op.layer || existing.has(op.shape.shapeId)) return false
            existing.add(op.shape.shapeId)
            return true
        })
        const parent = freshShapes ? doc.defaultLayerId() : null
        if (parent) {
            return doc.withLineAppender(opts.authorUuid, (_append, appendBatch) =>
                applyLocalOps(doc, overlay, ops, opts, (lines) => appendBatch(lines, parent)))
        }
    }
    return applyLocalOps(doc, overlay, ops, opts)
}

function applyLocalOps(
    doc: RmDocument,
    overlay: OverlayDocument,
    ops: LocalOp[],
    opts: ApplyOptions,
    appendFresh?: (lines: Line[]) => SceneLineItemBlock[],
): ApplyResult {
    const deltas: Op[] = []
    const upsert = (shape: OverlayShape, existing: OverlayShape | undefined) => {
        if (existing) overlay.shapes = overlay.shapes.map(current => current === existing ? shape : current)
        else overlay.shapes.push(shape)
        deltas.push({
            op: 'upsert-object', id: shape.shapeId, objType: shape.kind, props: shape.props,
            transform: { x: shape.x, y: shape.y, rotation: shape.rotation },
            ...(shape.opacity !== undefined && { opacity: shape.opacity }),
            ...(shape.opacityVersion && { opacityVersion: shape.opacityVersion }),
            rendered: shape.rendered, version: shape.version, renderRevision: shape.renderRevision,
            ...(shape.browserIndex !== undefined && { browserIndex: shape.browserIndex }),
            ...(shape.browserIndexVersion && { browserIndexVersion: shape.browserIndexVersion }),
        })
    }
    let complete = true
    for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        switch (op.type) {
            case 'set-browser-index': {
                const existing = overlay.shapes.find(shape => shape.shapeId === op.shapeId)
                if (!existing || (op.from !== undefined && existing.browserIndex !== op.from)) break
                const next = mergeBrowserOrder(existing, {
                    browserIndex: op.index, browserIndexVersion: op.version, version: op.version,
                })
                if (next !== existing) upsert(next, existing)
                break
            }
            case 'upsert-shape': {
                // Wall-clock LWW register: applyOps is ALSO a merge site —
                // in op-mode runReconcileOps pulls foreign ops BEFORE it pushes,
                // so a STALE local pending upsert can meet a NEWER already-merged
                // remote edit to the same id here. Enforce the same
                // strictly-greater guard as mergeOverlayOp: if the incoming
                // version is not strictly newer than the currently-stored version
                // (live shape OR tombstone), drop the whole mutation — do not
                // mint strokes, do not tombstone the winner's ink, do not emit an
                // upsert-object delta. Otherwise the loser would clobber the
                // winner and (via the ink-reconcile path) even propagate back.
                const currentVersion = currentObjectVersion(overlay, op.shape.shapeId)
                const existing = overlay.shapes.find((s) => s.shapeId === op.shape.shapeId)
                const deletedAt = overlay.tombstones?.[op.shape.shapeId]
                if (currentVersion !== null && compareVersion(op.shape.version, currentVersion) <= 0) {
                    if (existing) {
                        const ordered = op.shape.browserIndexVersion ? mergeBrowserOrder(existing, op.shape) : existing
                        const next = mergeShapeOpacity(ordered, op.shape, deletedAt)
                        if (next !== existing) upsert(next, existing)
                    }
                    break
                }
                // CONTENT idempotence: if a peer already
                // projected this exact shape state (same renderRevision),
                // minting our own copy would tombstone the same old ink and
                // add a SECOND set of strokes under our author - the overlay
                // register keeps one projection but nothing reaps the
                // loser's ink, so the page grows a duplicate ghost of every
                // shape (two clients opening one page right after a
                // PROJECTION_VERSION bump). Same content = nothing to do.
                // EXEMPT a detached shape: re-attach intentionally re-renders
                // the SAME props over diverged ink, so equal revisions there
                // are the point, not a duplicate.
                if (
                    existing &&
                    existing.state !== 'detached' &&
                    op.shape.renderRevision !== '' &&
                    existing.renderRevision === op.shape.renderRevision
                ) {
                    // Opacity affects the browser only. Keep the accepted native refs.
                    const edited = mergeShapeOpacity({ ...op.shape, rendered: existing.rendered, state: 'live' }, existing, deletedAt)
                    const opacityWritten = edited.opacity !== undefined && (existing.opacity === undefined ||
                        compareVersion(edited.opacityVersion ?? edited.version, existing.opacityVersion ?? existing.version) > 0)
                    if (opacityWritten) {
                        upsert(mergeBrowserOrder(edited, existing), existing)
                    } else {
                        const next = mergeBrowserOrder(existing, op.shape)
                        if (next !== existing && next.browserIndex !== existing.browserIndex) upsert(next, existing)
                    }
                    break
                }
                const parentId = op.layer ? (layerRefToId(doc, op.layer) ?? undefined) : undefined
                // PER-PART incremental re-mint: a part
                // whose contentHash is unchanged REUSES its already-minted
                // strokes — no tombstone, no re-add — so a one-character text
                // edit costs ~one glyph, not the whole shape. Reuse requires:
                //   - same partKey with an equal contentHash (hash covers
                //     geometry AND style),
                //   - every existing item still LIVE in the doc (a device
                //     erase voids the part: reusing it would claim provenance
                //     the rm no longer has),
                //   - the same target layer (a layer move must re-mint so the
                //     strokes actually move).
                const reused = new Map<string, RenderedPart>()
                if (existing && existing.state !== 'detached') {
                    const resolver = new RefResolver(doc)
                    const incomingHash = new Map(
                        op.parts.map((p) => [p.partKey, hashStrokes(p.strokes)]),
                    )
                    const targetParent = parentId ?? doc.defaultLayerId()
                    for (const part of existing.rendered) {
                        if (part.contentHash === undefined) continue
                        if (incomingHash.get(part.partKey) !== part.contentHash) continue
                        let allLive = part.items.length > 0
                        let sameLayer = true
                        for (const ref of part.items) {
                            const id = resolver.toId(ref)
                            const block = id ? doc.findLineItem(id) : null
                            if (!block || block.deletedLength > 0) {
                                allLive = false
                                break
                            }
                            if (
                                targetParent &&
                                crdtIdKey(block.parentId) !== crdtIdKey(targetParent)
                            ) {
                                sameLayer = false
                                break
                            }
                        }
                        if (allLive && sameLayer) reused.set(part.partKey, part)
                    }
                    // PAINT ORDER (device = doc block order): fresh strokes
                    // append at the frontier, so a re-minted part would paint
                    // ABOVE any reused part that follows it in op.parts order
                    // (fill over contour, contour over label). Reuse therefore
                    // only a PREFIX of the paint-ordered parts: from the first
                    // changed part onward, everything re-mints, restoring the
                    // relative order. Typing (append at the end) keeps the
                    // full win; style edits on early parts fall back safely.
                    let prefixIntact = true
                    for (const part of op.parts) {
                        if (!reused.has(part.partKey)) prefixIntact = false
                        else if (!prefixIntact) reused.delete(part.partKey)
                    }
                }
                // Tombstone the parts NOT carried forward — for EVERY existing
                // shape, detached included (re-attach re-projects from props;
                // the old surviving strokes must die or they linger as loose
                // double-rendered ink — pruneInkShapes keys on exactly this).
                // Skip the delta for already-dead items (a repair
                // re-projection's dropped part was erased by the device —
                // re-shipping its tombstones is redundant wire noise).
                if (existing) {
                    const resolver = new RefResolver(doc)
                    for (const part of existing.rendered) {
                        if (reused.has(part.partKey)) continue
                        for (const ref of part.items) {
                            const id = resolver.toId(ref)
                            if (!id) continue
                            const wasLive = (doc.findLineItem(id)?.deletedLength ?? 1) === 0
                            doc.tombstone(id)
                            if (wasLive) deltas.push({ op: 'tombstone', id: idToOpRef(doc, id) })
                        }
                    }
                }
                // Batch-mint the strokes of CHANGED/NEW parts in one append (one
                // clock+frontier computation, not one per stroke — the page
                // -build O(n^2) hot path). Remember each part's stroke count
                // so we can slice the minted blocks back per part.
                const freshParts = op.parts.filter((p) => !reused.has(p.partKey))
                // 2dp coords at the MINT: the float64 repr of projected
                // points carries ~17 digits of noise per axis (~100B/point on
                // the wire). 0.01 ink units is ~3µm on device; hashStrokes
                // quantizes at 0.1, so part-reuse hashes are unaffected.
                // Rounding is safe ONLY here, where the rounded value becomes
                // the item's canonical origin everywhere (2dp survives the
                // float32 store round-trip bit-exactly).
                const flatStrokes = freshParts
                    .flatMap((p) => p.strokes)
                    .map((s) => ({
                        ...s,
                        points: s.points.map((pt) => ({
                            ...pt,
                            x: Math.round(pt.x * 100) / 100,
                            y: Math.round(pt.y * 100) / 100,
                        })),
                    }))
                const lines = flatStrokes.map((stroke): Line => ({
                    kind: 'line' as const,
                    // per-stroke pen (e.g. highlighter) overrides the
                    // session default; both fall back to the marker
                    tool: stroke.pen ?? opts.pen ?? Pen.MARKER_2,
                    color: tldrawColorToPenColor(stroke.color),
                    thicknessScale: 2,
                    startingLength: 0,
                    timestamp: { part1: 0, part2: 1 }, // replaced by appendLines
                    moveId: null,
                    points: stroke.points,
                }))
                const blocks = appendFresh ? appendFresh(lines) : doc.appendLines(lines, {
                    authorUuid: opts.authorUuid, ...(parentId ? { parentId } : {}),
                })
                const resolver = new RefResolver(doc) // author table stable post-append
                // capture every minted line as an addItem delta (origins verbatim)
                for (const block of blocks) deltas.push(lineBlockToAddOp(doc, block))
                const freshRendered = new Map<string, RenderedPart>()
                let cursor = 0
                for (const part of freshParts) {
                    const items: ItemRef[] = []
                    for (let i = 0; i < part.strokes.length; i++) {
                        const ref = resolver.toRef(blocks[cursor++]!.itemId)
                        if (ref) items.push(ref)
                    }
                    freshRendered.set(part.partKey, {
                        partKey: part.partKey,
                        items,
                        contentHash: hashStrokes(part.strokes),
                    })
                }
                // rendered follows op.parts order; reused parts carry their refs
                const rendered: RenderedPart[] = op.parts.map(
                    (p) => reused.get(p.partKey) ?? freshRendered.get(p.partKey)!,
                )
                const next = mergeBrowserOrder(mergeShapeOpacity({ ...op.shape, rendered, state: 'live' }, existing, deletedAt), existing)
                upsert(next, existing)
                break
            }
            case 'remove-shape': {
                // LWW register: a STALE delete (version <= the stored
                // version) must not remove a newer live shape or overwrite a
                // newer tombstone. Same strictly-greater guard as mergeOverlayOp.
                const currentVersion = currentObjectVersion(overlay, op.shapeId)
                if (currentVersion !== null && compareVersion(op.version, currentVersion) <= 0) {
                    break // stale/idempotent
                }
                const existing = overlay.shapes.find((s) => s.shapeId === op.shapeId)
                // Unknown id -> deliberate no-op (no tombstone, no delta). This
                // differs from mergeOverlayOp, which tombstones unknown ids —
                // correct there because remote deletes can arrive before their
                // upsert. remove-shape is a PRODUCER-side op: the user can only
                // delete a shape their editor shows, so an unknown id here is a
                // ghost (already removed), and minting a tombstone would ship a
                // delete-object for a shape no peer has.
                if (!existing) break
                const resolver = new RefResolver(doc)
                for (const part of existing.rendered) {
                    for (const ref of part.items) {
                        const id = resolver.toId(ref)
                        if (id) {
                            doc.tombstone(id)
                            deltas.push({ op: 'tombstone', id: idToOpRef(doc, id) })
                        }
                    }
                }
                overlay.shapes = overlay.shapes.filter((s) => s.shapeId !== op.shapeId)
                overlay.tombstones ??= {}
                overlay.tombstones[op.shapeId] = op.version
                deltas.push({ op: 'delete-object', id: op.shapeId, version: op.version })
                break
            }
            case 'release-shape': {
                // LWW register: a stale release must not overwrite a newer
                // live shape or tombstone. Same strictly-greater guard.
                const currentVersion = currentObjectVersion(overlay, op.shapeId)
                if (currentVersion !== null && compareVersion(op.version, currentVersion) <= 0) {
                    break // stale/idempotent
                }
                // forget the overlay shape but keep its ink: only the object op,
                // no tombstones on the ink (the strokes stay live on the page),
                // but a versioned overlay tombstone so a stale upsert can't
                // resurrect the object.
                overlay.shapes = overlay.shapes.filter((s) => s.shapeId !== op.shapeId)
                overlay.tombstones ??= {}
                overlay.tombstones[op.shapeId] = op.version
                deltas.push({ op: 'delete-object', id: op.shapeId, version: op.version })
                break
            }
            case 'insert-image': {
                // image adds have no replayable ink delta yet (InkDeltaApplier
                // rejects them): force snapshot fallback rather than emit an op
                // the consumer can't replay.
                complete = false
                const author = doc.resolveAuthor(opts.authorUuid)
                // registry: ensure a SceneImageInfo block carries this asset
                let info = doc.blocks.find((b) => b.type === 'sceneImageInfo')
                if (info && info.type === 'sceneImageInfo') {
                    if (!info.images.some((img) => img.uuid === op.assetUuid)) {
                        const ts = crdtId(author, doc.maxClock(author) + 1)
                        info.images.push({
                            uuid: op.assetUuid,
                            filename: lww(ts, op.filename),
                            flags: lww(ts, new Uint8Array([17, 0])),
                        })
                    }
                } else {
                    const ts = crdtId(author, doc.maxClock(author) + 1)
                    doc.blocks.push({
                        type: 'sceneImageInfo',
                        version: { min: 3, current: 3 },
                        extraData: new Uint8Array(0),
                        images: [
                            {
                                uuid: op.assetUuid,
                                filename: lww(ts, op.filename),
                                flags: lww(ts, new Uint8Array([17, 0])),
                            },
                        ],
                    })
                }
                doc.appendImage(
                    {
                        kind: 'image',
                        uuid: lww(crdtId(author, doc.maxClock(author) + 1), uuidToBytesLE(op.assetUuid)),
                        timestamp: crdtId(0, 0), // set by appendImage
                        vertices: [...op.vertices],
                        indices: [0, 1, 2, 2, 3, 0],
                        filename: op.filename,
                    },
                    (() => {
                        const parentId = op.layer ? layerRefToId(doc, op.layer) : null
                        return { authorUuid: opts.authorUuid, ...(parentId ? { parentId } : {}) }
                    })(),
                )
                break
            }
            case 'move-image': {
                complete = false // tombstone+re-add of an image: not op-replayable yet
                const resolver = new RefResolver(doc)
                const id = resolver.toId(op.item)
                if (!id) break
                const block = doc.blocks.find(
                    (b) =>
                        b.type === 'sceneImageItem' &&
                        b.itemId.part1 === id.part1 &&
                        b.itemId.part2 === id.part2,
                )
                if (!block || block.type !== 'sceneImageItem' || !block.image) break
                const image = block.image
                doc.tombstone(id)
                doc.appendImage(
                    { ...image, vertices: [...op.vertices] },
                    { authorUuid: opts.authorUuid, parentId: block.parentId },
                )
                break
            }
            case 'edit-root-text': {
                complete = false // text ops have no op form yet (snapshot fallback)
                if (op.create && !doc.tree().rootText) createRootText(doc, op.create)
                const parseKey = (k: string) => {
                    const [a, b] = k.split(':').map(Number)
                    return crdtId(a!, b!)
                }
                for (const ins of op.inserts ?? []) {
                    let after = ins.afterKey ? parseKey(ins.afterKey) : null
                    if (ins.text !== undefined) {
                        insertText(doc, after, ins.text, { authorUuid: opts.authorUuid })
                    }
                    for (const code of ins.codes ?? []) {
                        // chain: each code lands right after the previous one
                        after = insertFormatCode(doc, after, code, {
                            authorUuid: opts.authorUuid,
                        })
                    }
                }
                if (op.deleteKeys?.length) deleteText(doc, op.deleteKeys.map(parseKey))
                for (const [key, style, extra] of op.styles ?? []) {
                    setParagraphStyle(doc, parseKey(key), style, {
                        authorUuid: opts.authorUuid,
                        ...(extra?.length ? { extra: new Uint8Array(extra) } : {}),
                    })
                }
                break
            }
            case 'create-layer': {
                complete = false // layer ops have no op form yet (snapshot fallback)
                doc.createLayer(op.label, { authorUuid: opts.authorUuid })
                break
            }
            case 'set-layer-visible': {
                complete = false // layer ops have no op form yet (snapshot fallback)
                const id = layerRefToId(doc, op.layer)
                if (id) doc.setLayerVisible(id, op.visible, { authorUuid: opts.authorUuid })
                break
            }
            case 'remove-ink': {
                const resolver = new RefResolver(doc)
                for (const ref of op.items) {
                    const id = resolver.toId(ref)
                    if (id) {
                        doc.tombstone(id)
                        deltas.push({ op: 'tombstone', id: idToOpRef(doc, id) })
                    }
                }
                break
            }
            case 'transform-ink': {
                // Adjacent journal entries can share allocation. Other ops
                // can mint IDs or change the file-order frontier.
                let move = op
                let resolver = new RefResolver(doc)
                let authors: Map<number, string> | undefined
                doc.withLineAppender(opts.authorUuid, (append) => {
                    while (true) {
                        // Registration is visible to the next intent. The
                        // current intent keeps its starting author table.
                        const sourceRefs = resolver
                        for (const it of move.items) {
                            const id = sourceRefs.toId(it.ref)
                            if (!id) continue
                            const block = doc.findLineItem(id)
                            if (!block || block.deletedLength > 0 || !block.line) continue
                            const translation = block.version.min === 0 && block.version.current === 2 &&
                                block.extraData.length === 0 && block.extraValueData.length === 0 ? it.translation : undefined
                            const points = translation
                                ? block.line.points.map((point) => ({
                                    ...point,
                                    x: Math.fround(point.x + translation.x),
                                    y: Math.fround(point.y + translation.y),
                                }))
                                : it.points.map((point) => ({
                                    ...point,
                                    x: Math.round(point.x * 100) / 100,
                                    y: Math.round(point.y * 100) / 100,
                                }))
                            const line = { ...block.line, points, moveId: id }
                            doc.tombstone(id)
                            const added = append(line, block.parentId)
                            if (!authors) {
                                authors = doc.authorTable()
                                resolver = new RefResolver(doc)
                            }
                            deltas.push({ op: 'tombstone', id: idToOpRef(doc, id, authors) })
                            deltas.push(lineBlockToAddOp(doc, added, authors))
                        }
                        const next = ops[i + 1]
                        if (next?.type !== 'transform-ink') break
                        move = next
                        i++
                    }
                })
                break
            }
        }
    }
    return { deltas, complete }
}

export function hashStrokes(strokes: InkStroke[]): string {
    let hash = 0x811c9dc5
    const mix = (n: number) => {
        hash ^= n & 0xff
        hash = Math.imul(hash, 0x01000193)
        hash ^= (n >> 8) & 0xff
        hash = Math.imul(hash, 0x01000193)
    }
    for (const stroke of strokes) {
        // style is content: a color/pen change with identical geometry must
        // produce a different hash, or per-part reuse would keep stale ink
        for (let i = 0; i < stroke.color.length; i++) mix(stroke.color.charCodeAt(i))
        mix(stroke.pen ?? -1)
        for (const p of stroke.points) {
            mix(Math.round(p.x * 10))
            mix(Math.round(p.y * 10))
            mix(p.width)
        }
    }
    return (hash >>> 0).toString(16)
}
