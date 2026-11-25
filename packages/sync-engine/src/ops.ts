/**
 * Op model: the wire format. Edits travel as commutative, id-anchored CRDT
 * deltas instead of whole-blob CAS — each delta carries the item's own id and
 * its YATA origins, so peers apply them in any order and converge (no CAS, no
 * 409, no rebase, no OT transform); the server is a dumb opaque relay.
 *
 *   addItem    { id, parent, left, right, payload }   // a scene item + origins
 *   tombstone  { id }                                  // mark an item deleted
 *   upsertObject { id, objType, props, transform, rendered }  // overlay shape
 *   deleteObject { id }
 *
 * Device rule: origins must be adjacent in xochitl's sequence view. addItem
 * ops carry the origins the minting peer already computed (frontier-chained),
 * and applyInkDelta preserves them verbatim rather than re-deriving from
 * toposort order, which hard-hangs the tablet.
 */

import {
    RmDocument,
    crdtId,
    crdtIdKey,
    type CrdtId,
    type Point,
    type SceneLineItemBlock,
} from '@weft/rm-format'
import type { OpVersion, OverlayDocument, OverlayShape, OverlayShapeKind, RenderedPart } from './types'

/**
 * Portable, cross-file CRDT id: author UUID (null = system author 0) + clock.
 * The END origin is `{ author: null, clock: 0 }`. File-local author *indices*
 * are remapped by xochitl on rewrite, so the UUID is the stable form.
 */
export interface OpRef {
    author: string | null
    clock: number
}

export const OP_END: OpRef = { author: null, clock: 0 }

export interface LinePayload {
    kind: 'line'
    tool: number
    color: number
    thicknessScale: number
    startingLength: number
    moveId: OpRef | null
    points: Point[]
}

export interface ImagePayload {
    kind: 'image'
    /** Canonical asset uuid string; bytes live in the page asset dir. */
    assetUuid: string
    /** 4 corners x (x, y, u, v), ink units. */
    vertices: number[]
    filename: string | null
}

export type ItemPayload = LinePayload | ImagePayload

export interface AddItemOp {
    op: 'add'
    id: OpRef
    parent: OpRef
    left: OpRef
    right: OpRef
    payload: ItemPayload
}

export interface TombstoneOp {
    op: 'tombstone'
    id: OpRef
}

/**
 * Total order over wall-clock LWW versions (D7): higher `ts` wins; equal `ts`
 * -> higher `actor` string wins. Returns >0 if `a` is newer than `b`, <0 if
 * older, 0 if equal. Deterministic and antisymmetric, so applying a shuffled op
 * batch converges. `OpVersion` is stamped with wall-clock ms + clientId at
 * edit time, deliberately not a per-actor sequence: a stale offline client
 * with a high counter would otherwise clobber newer edits.
 */
export function compareVersion(
    a: OpVersion | undefined,
    b: OpVersion | undefined,
): number {
    // Ops/shapes minted before versioning shipped carry no version, and the
    // op log is immutable, so replay meets them forever. Treat a missing
    // version as the epoch (ts 0): legacy edits are always-oldest, any
    // versioned edit beats them, legacy-vs-legacy is a stable tie.
    const av = a ?? EPOCH_VERSION
    const bv = b ?? EPOCH_VERSION
    if (av.ts !== bv.ts) return av.ts - bv.ts
    if (av.actor === bv.actor) return 0
    return av.actor > bv.actor ? 1 : -1
}

const EPOCH_VERSION: OpVersion = { ts: 0, actor: '' }

export interface UpsertObjectOp {
    op: 'upsert-object'
    /** Stable overlay shape id (tldraw shape id). */
    id: string
    /** Namespaced object type, e.g. "weft.text" / a tldraw shape kind. */
    objType: string
    props: unknown
    transform: { x: number; y: number; rotation: number }
    /** Omitted by legacy writers. An explicit 1 restores full opacity. */
    opacity?: number
    opacityVersion?: OpVersion
    rendered: RenderedPart[]
    /** Wall-clock LWW version — decides same-id conflicts (D7). */
    version: OpVersion
    /**
     * Hash of props+transform that produced `rendered`; optional so
     * third-party object types need not carry it. When present it's
     * reproduced verbatim so the rebuilt overlay matches the producer's, and
     * the strictly-greater version guard in apply-ops keeps a re-applied
     * pending op idempotent across a crash.
     */
    renderRevision?: string
    browserIndex?: string
    browserIndexVersion?: OpVersion
}

export interface DeleteObjectOp {
    op: 'delete-object'
    id: string
    /** Wall-clock LWW version — a delete carries a version so a stale upsert
     *  (lower version) cannot resurrect it, and a newer upsert can (D7). */
    version: OpVersion
}

export type Op = AddItemOp | TombstoneOp | UpsertObjectOp | DeleteObjectOp

// ----- id <-> OpRef -----

/** CrdtId in `doc` -> portable OpRef (author 0 -> null). */
export function idToOpRef(doc: RmDocument, id: CrdtId, authors?: ReadonlyMap<number, string>): OpRef {
    if (id.part1 === 0) return { author: null, clock: id.part2 }
    const uuid = (authors ?? doc.authorTable()).get(id.part1)
    if (!uuid) {
        // A non-zero author index missing from the file's authorIds block
        // means a malformed or foreign .rm. Falling back to author:null
        // (system) can drop/mismerge the stroke on round-trip, but throwing
        // would abort reconstruct for the whole page, a worse degrade — warn
        // instead so it's diagnosable.
        console.warn(`weft: idToOpRef unknown author index ${id.part1}; treating as system`)
        return { author: null, clock: id.part2 }
    }
    return { author: uuid.toLowerCase(), clock: id.part2 }
}

/**
 * OpRef -> CrdtId in `doc`, registering the author if new. Registering even for
 * a not-yet-present item means an origin/parent that references an item which
 * hasn't arrived yet still resolves to a stable id, so out-of-order delivery
 * still converges.
 */
export function opRefToId(doc: RmDocument, ref: OpRef): CrdtId {
    if (ref.author === null) return crdtId(0, ref.clock)
    return crdtId(doc.resolveAuthor(ref.author), ref.clock)
}

// ----- codec (opaque BLOB on the wire + in page_ops; deterministic JSON) -----

export function encodeOp(op: Op): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(op))
}

export function decodeOp(bytes: Uint8Array): Op {
    return JSON.parse(new TextDecoder().decode(bytes)) as Op
}

// ----- derive ink deltas from minted blocks (client capture path) -----

/** Capture a freshly-minted line block as an addItem delta to ship. */
export function lineBlockToAddOp(doc: RmDocument, b: SceneLineItemBlock, authors?: ReadonlyMap<number, string>): AddItemOp {
    if (!b.line) throw new Error('lineBlockToAddOp: block has no line value')
    const line = b.line
    return {
        op: 'add',
        id: idToOpRef(doc, b.itemId, authors),
        parent: idToOpRef(doc, b.parentId, authors),
        left: idToOpRef(doc, b.leftId, authors),
        right: idToOpRef(doc, b.rightId, authors),
        payload: {
            kind: 'line',
            tool: line.tool,
            color: line.color,
            thicknessScale: line.thicknessScale,
            startingLength: line.startingLength,
            moveId: line.moveId ? idToOpRef(doc, line.moveId, authors) : null,
            // Preserve coordinates verbatim: this path re-encodes
            // EXISTING doc items (incl. device strokes on the bridge), and
            // any coordinate change breaks byte-equality between the device
            // file and the cloud reconstruction. The daemon's pull skips
            // write-back only on sha-equal bytes, so a divergence here
            // rewrites the page under the user's pen after every stroke
            // (2026-07-14 incident). Wire-size rounding happens at the
            // PROJECTION mint instead, where rounded values are the origin.
            // Replay writes v2 line blocks. Retain the historic v1 width
            // quantization when converting to that integer encoding.
            points: line.points.map((p) => ({
                ...p,
                width: b.version.current === 1 ? Math.round(p.width) : p.width,
            })),
        },
    }
}

/**
 * Capture a VALUELESS dead block. xochitl drops the line value on erase, so a
 * stroke drawn+erased between pushes arrives dead with no payload — but the
 * block itself stays in the file, and byte-equality needs the replica to carry
 * it too. The dummy payload never reaches a doc: the paired tombstone nulls
 * the value, so the replica serializes the same valueless dead block as the
 * device file.
 */
export function deadLineBlockToAddOp(doc: RmDocument, b: SceneLineItemBlock): AddItemOp {
    return {
        op: 'add',
        id: idToOpRef(doc, b.itemId),
        parent: idToOpRef(doc, b.parentId),
        left: idToOpRef(doc, b.leftId),
        right: idToOpRef(doc, b.rightId),
        payload: {
            kind: 'line',
            tool: 0,
            color: 0,
            thicknessScale: 0,
            startingLength: 0,
            moveId: null,
            points: [],
        },
    }
}

// ----- apply a received ink delta (commutative + idempotent) -----

const SCENE_ITEM_TYPES = new Set([
    'sceneLineItem',
    'sceneGlyphItem',
    'sceneImageItem',
    'sceneGroupItem',
    'sceneTombstoneItem',
])

function findItem(doc: RmDocument, id: CrdtId): { itemId: CrdtId } | undefined {
    const key = crdtIdKey(id)
    return doc.blocks.find(
        (b) =>
            SCENE_ITEM_TYPES.has((b as { type: string }).type) &&
            crdtIdKey((b as unknown as { itemId: CrdtId }).itemId) === key,
    ) as { itemId: CrdtId } | undefined
}

/**
 * Applies ink deltas (line add / tombstone) into a doc with full any-order
 * convergence. Holding per-doc state handles the one case a stateless apply
 * can't: a tombstone arriving before its addItem. rm-format's `tombstone`
 * only flips an existing block, so a tombstone for an absent item is
 * remembered and applied when the add lands, otherwise reordering could
 * resurrect a deleted item.
 *
 * Idempotent (repeat add = no-op; repeat tombstone re-marks) and commutative
 * for content: any permutation of a delta set converges to the same live/dead
 * set and the same YATA origins.
 *
 * Caveat (not a divergence): render z-order of concurrent, same-origin inserts
 * from different authors tie-breaks on the file-local author index (xochitl's
 * device rule), assigned in author-table order, which can differ across
 * peers. This only reorders overlapping strokes' paint order; which strokes
 * exist always converges. Kept to match xochitl's own tie-break.
 *
 * Image addItem apply is a later sub-step; passing one throws so callers can't
 * silently drop it.
 */
export class InkDeltaApplier {
    private pendingTombstones = new Set<string>()

    constructor(private readonly doc: RmDocument) {}

    apply(op: AddItemOp | TombstoneOp): void {
        if (op.op === 'tombstone') {
            const id = opRefToId(this.doc, op.id)
            if (!this.doc.tombstone(id)) this.pendingTombstones.add(crdtIdKey(id))
            return
        }
        const itemId = opRefToId(this.doc, op.id)
        if (findItem(this.doc, itemId)) return // already present: idempotent no-op
        if (op.payload.kind !== 'line') {
            throw new Error(`InkDeltaApplier: ${op.payload.kind} addItem not yet supported`)
        }
        const tombstoned = this.pendingTombstones.delete(crdtIdKey(itemId))
        const block: SceneLineItemBlock = {
            type: 'sceneLineItem',
            version: { min: 0, current: 2 },
            extraData: new Uint8Array(0),
            extraValueData: new Uint8Array(0),
            parentId: opRefToId(this.doc, op.parent),
            itemId,
            leftId: opRefToId(this.doc, op.left),
            rightId: opRefToId(this.doc, op.right),
            // a tombstone that arrived first: materialize the item already dead
            deletedLength: tombstoned ? 1 : 0,
            line: tombstoned
                ? null
                : {
                      kind: 'line',
                      tool: op.payload.tool,
                      color: op.payload.color,
                      points: op.payload.points.map((p) => ({ ...p })),
                      thicknessScale: op.payload.thicknessScale,
                      startingLength: op.payload.startingLength,
                      timestamp: itemId,
                      moveId: op.payload.moveId ? opRefToId(this.doc, op.payload.moveId) : null,
                  },
        }
        this.doc.blocks.push(block)
    }
}

/** Apply a batch of ink deltas to `doc` in any order, converging. */
export function applyInkDeltas(doc: RmDocument, ops: (AddItemOp | TombstoneOp)[]): void {
    const applier = new InkDeltaApplier(doc)
    for (const op of ops) applier.apply(op)
}

// ----- apply a received op batch (ink + overlay) — the consumer path -----

/**
 * The current LWW version stored for an object id: the live shape's version if
 * present, else the tombstone's version if it was deleted, else null (unknown
 * id). This is the register `mergeOverlayOp` compares against.
 */
export function currentObjectVersion(overlay: OverlayDocument, id: string): OpVersion | null {
    const live = overlay.shapes.find((s) => s.shapeId === id)
    if (live) return live.version
    return overlay.tombstones?.[id] ?? null
}

/** A metadata-only reorder cannot replace the shape's accepted content. */
export function mergeBrowserOrder(
    shape: OverlayShape,
    other: Pick<OverlayShape, 'browserIndex' | 'browserIndexVersion' | 'version'> | undefined,
): OverlayShape {
    if (other?.browserIndex === undefined) return shape
    const incoming = other.browserIndexVersion ?? other.version
    if (shape.browserIndex !== undefined && compareVersion(incoming, shape.browserIndexVersion ?? shape.version) <= 0) {
        return shape
    }
    return { ...shape, browserIndex: other.browserIndex, browserIndexVersion: incoming }
}

export function shapeOpacity(value: unknown): number | undefined {
    return typeof value === 'number' && value >= 0 && value <= 1 ? value : undefined
}

/** Merge the most recent explicit browser opacity independently of geometry. */
export function mergeShapeOpacity(
    shape: OverlayShape,
    other: Pick<OverlayShape, 'kind' | 'version' | 'opacity' | 'opacityVersion'> | undefined,
    deletedAt: OpVersion | undefined,
): OverlayShape {
    const write = (source: NonNullable<typeof other>) => {
        const opacity = shapeOpacity(source.opacity)
        const version = source.opacityVersion ?? source.version
        if (opacity === undefined || compareVersion(version, source.version) > 0 ||
            (deletedAt && compareVersion(version, deletedAt) <= 0)) return undefined
        return { opacity, version }
    }
    const current = write(shape)
    const incoming = other?.kind === shape.kind ? write(other) : undefined
    if (incoming && (!current || compareVersion(incoming.version, current.version) > 0)) {
        return { ...shape, opacity: incoming.opacity, opacityVersion: incoming.version }
    }
    if (current || (shape.opacity === undefined && shape.opacityVersion === undefined)) return shape
    const next = { ...shape }
    delete next.opacity
    delete next.opacityVersion
    return next
}

/**
 * LWW-merge two whole overlay documents (per-shape `compareVersion`, tombstone
 * union by max version). Snapshot adoption must go through this, never a
 * wholesale replace: a snapshot is composed at some past instant, so replacing
 * would regress every local shape edited since, re-triggering full
 * re-projections on every device echo. Ties keep `local` (preserves the
 * client-local `detached` state; an equal version is equal content).
 */
export function mergeOverlayDocuments(
    local: OverlayDocument,
    incoming: OverlayDocument,
): OverlayDocument {
    const out: OverlayDocument = { shapes: [], tombstones: {} }
    const ids = new Set([
        ...Object.keys(local.tombstones ?? {}),
        ...Object.keys(incoming.tombstones ?? {}),
    ])
    for (const id of ids) {
        const a = local.tombstones?.[id] ?? null
        const b = incoming.tombstones?.[id] ?? null
        out.tombstones![id] = a && b ? (compareVersion(a, b) >= 0 ? a : b) : (a ?? b)!
    }
    const incomingById = new Map(incoming.shapes.map((s) => [s.shapeId, s]))
    const place = (shape: OverlayShape, previous?: OverlayShape) => {
        const t = out.tombstones![shape.shapeId]
        if (t && compareVersion(t, shape.version) >= 0) return // a newer-or-equal delete wins
        out.shapes.push(mergeBrowserOrder(mergeShapeOpacity(shape, previous, t), previous))
    }
    const seen = new Set<string>()
    for (const l of local.shapes) {
        seen.add(l.shapeId)
        const r = incomingById.get(l.shapeId)
        const incomingWins = r && compareVersion(r.version, l.version) > 0
        place(incomingWins ? r : l, incomingWins ? l : r)
    }
    for (const r of incoming.shapes) {
        if (!seen.has(r.shapeId)) place(r)
    }
    return out
}

/** Outcome of an LWW overlay merge — lets stateful callers emit view patches. */
export type OverlayMerge =
    | { kind: 'none' } // stale/idempotent: not strictly newer, dropped
    | { kind: 'upsert'; shape: OverlayShape } // shape (re)created/updated
    | { kind: 'delete'; shapeId: string; existed: boolean } // tombstoned

/**
 * Apply ONE overlay op to the overlay as a wall-clock LWW register keyed by
 * object id (D7). The op wins ONLY IF its version is strictly greater than the
 * currently-stored version (live shape or tombstone) for that id. Paint order
 * and explicit opacity also carry their own versions, so a metadata edit can
 * survive a newer shape update from a client that omitted it.
 *
 * A delete leaves a versioned tombstone, so a stale upsert cannot resurrect a
 * deleted object while a newer upsert can. Different ids never conflict
 * (union-by-id). Idempotent: re-applying the same op is a no-op (an equal
 * version is not strictly greater).
 */
export function mergeOverlayOp(overlay: OverlayDocument, op: UpsertObjectOp | DeleteObjectOp): OverlayMerge {
    const current = currentObjectVersion(overlay, op.id)
    const i = overlay.shapes.findIndex(shape => shape.shapeId === op.id)
    const existing = overlay.shapes[i]
    const deletedAt = overlay.tombstones?.[op.id]
    if (op.op === 'upsert-object') {
        const kind = op.objType as OverlayShapeKind
        const opacityWrite = { ...op, kind }
        const opacity = shapeOpacity(op.opacity)
        if (current !== null && compareVersion(op.version, current) <= 0) {
            if (!existing) return { kind: 'none' }
            const ordered = op.browserIndexVersion ? mergeBrowserOrder(existing, op) : existing
            const shape = mergeShapeOpacity(ordered, opacityWrite, deletedAt)
            if (shape === existing) return { kind: 'none' }
            overlay.shapes[i] = shape
            return { kind: 'upsert', shape }
        }
        const shape = mergeBrowserOrder(mergeShapeOpacity({
            shapeId: op.id,
            kind,
            props: op.props,
            x: op.transform.x,
            y: op.transform.y,
            rotation: op.transform.rotation,
            ...(opacity !== undefined && { opacity, ...(op.opacityVersion && { opacityVersion: op.opacityVersion }) }),
            rendered: op.rendered,
            renderRevision: op.renderRevision ?? '',
            state: 'live',
            version: op.version,
            ...(op.browserIndex !== undefined && { browserIndex: op.browserIndex }),
            ...(op.browserIndexVersion && { browserIndexVersion: op.browserIndexVersion }),
        }, existing, deletedAt), existing)
        if (i >= 0) overlay.shapes[i] = shape
        else overlay.shapes.push(shape)
        return { kind: 'upsert', shape }
    }
    if (deletedAt && compareVersion(op.version, deletedAt) <= 0) return { kind: 'none' }
    overlay.tombstones ??= {}
    overlay.tombstones[op.id] = op.version
    if (existing && compareVersion(op.version, existing.version) < 0) {
        const shape = mergeShapeOpacity(existing, undefined, op.version)
        if (shape === existing) return { kind: 'none' }
        overlay.shapes[i] = shape
        return { kind: 'upsert', shape }
    }
    // delete-object: drop the live shape, leave a versioned tombstone
    const existed = overlay.shapes.some((s) => s.shapeId === op.id)
    overlay.shapes = overlay.shapes.filter((s) => s.shapeId !== op.id)
    return { kind: 'delete', shapeId: op.id, existed }
}

/**
 * Replay a batch of ops onto a (doc, overlay) pair, converging regardless of
 * order. This is the consumer twin of `applyOps`'s producer capture: the
 * deltas `applyOps` returns, replayed here over a fresh copy of the same base,
 * reproduce the producer's exact converged state. Also the "replay" half of
 * reconstruct = snapshot + replay.
 *
 * Ink (add/tombstone) goes through InkDeltaApplier (handles tombstone-before-add
 * and idempotent re-adds). Overlay ops are a wall-clock LWW register keyed by id
 * (mergeOverlayOp, D7): the higher-version edit wins per id, deletes leave
 * versioned tombstones, different ids union. Both channels are id-anchored and
 * version-ordered, so a shuffled batch converges (z-order caveat as documented
 * on InkDeltaApplier).
 */
export function applyRemoteOps(doc: RmDocument, overlay: OverlayDocument, ops: Op[]): void {
    const inkOps = ops.filter((o): o is AddItemOp | TombstoneOp => o.op === 'add' || o.op === 'tombstone')
    applyInkDeltas(doc, inkOps)
    foldOverlayOps(overlay, ops)
}

/** Just the overlay half of applyRemoteOps: fold the object ops (LWW register)
 *  and ignore ink ops. For callers that already materialized the ink elsewhere
 *  (e.g. history stateAt = reconstructRm + this) — avoids re-applying ink deltas
 *  to a throwaway doc. */
export function foldOverlayOps(overlay: OverlayDocument, ops: Op[]): void {
    for (const op of ops) {
        if (op.op === 'upsert-object' || op.op === 'delete-object') mergeOverlayOp(overlay, op)
    }
}
