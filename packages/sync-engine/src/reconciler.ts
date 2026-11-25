/**
 * Reconciliation policies (ARCHITECTURE §4): what to do when the tablet
 * touched a projection. Pure decisions; the session executes them.
 */

import { crdtIdEquals, type CrdtId, type Line, type RmDocument } from '@weft/rm-format'
import { RM_SCALE } from '@weft/rm-ink/pure'
import { collectItemRefs, RefResolver } from './refs'
import {
    itemRefKey,
    type ItemRef,
    type OverlayDocument,
    type OverlayShape,
    type PageDiff,
    type ShapeEdit,
} from './types'

export type ReconcileDecision =
    | { type: 'repair'; shapeId: string; edit: ShapeEdit }
    | { type: 'detach'; shapeId: string }

export type AuditDecision =
    | ReconcileDecision
    /** Every rendered item is gone: the tablet deleted or moved the whole
     *  shape (xochitl moves = tombstone + re-create under its own author).
     *  The overlay shape must dissolve or it ghosts forever: a live overlay
     *  shape pointing at tombstones re-renders every reload while the moved
     *  ink renders as foreign strokes. */
    | { type: 'remove'; shapeId: string }

type InkDelta = { dx: number; dy: number }

interface MoveLine {
    ref: ItemRef
    line: Line
    origin: string | null
    layer: string | null
}

function indexMoveLines(doc: RmDocument) {
    const resolver = new RefResolver(doc)
    const layers = new Map<string, CrdtId | null>()
    const layerKey = (id: CrdtId) => {
        if (id.part1 === 0) return `system:${id.part2}`
        const ref = resolver.toRef(id)
        return ref && itemRefKey(ref)
    }
    for (const block of doc.blocks) {
        const id = block.type === 'sceneTree' ? block.treeId
            : block.type === 'treeNode' || block.type === 'sceneGroupItem' ? block.nodeId
            : null
        if (!id) continue
        const key = layerKey(id)
        if (!key) continue
        const known = layers.get(key)
        if (known === undefined) layers.set(key, id)
        else if (known && !crdtIdEquals(known, id)) layers.set(key, null)
    }

    const items = new Map<string, MoveLine | null>()
    const itemLayers = new Map<string, string | null>()
    const ambiguous = new Set<string>()
    const live = new Set<string>()
    const successors = new Map<string, MoveLine[]>()
    for (const block of doc.blocks) {
        if (!('itemId' in block) || block.type === 'sceneGroupItem') continue
        const ref = resolver.toRef(block.itemId)
        if (!ref) continue
        const key = itemRefKey(ref)
        const duplicate = itemLayers.has(key)
        const parent = layerKey(block.parentId)
        const layer = parent && layers.get(parent)
        const uniqueLayer = layer && crdtIdEquals(layer, block.parentId) ? parent : null
        itemLayers.set(key, duplicate ? null : uniqueLayer)
        if (block.deletedLength === 0) live.add(key)
        if (duplicate) {
            ambiguous.add(key)
            if (items.has(key)) items.set(key, null)
        }
        if (block.type !== 'sceneLineItem' || block.deletedLength > 0 || !block.line) continue
        const origin = block.line.moveId && resolver.toRef(block.line.moveId)
        const item: MoveLine = {
            ref,
            line: block.line,
            origin: origin && itemRefKey(origin),
            layer: uniqueLayer,
        }
        items.set(key, duplicate ? null : item)
        if (item.origin) {
            const candidates = successors.get(item.origin) ?? []
            candidates.push(item)
            successors.set(item.origin, candidates)
        }
    }
    return { items, itemLayers, successors, live, ambiguous }
}

type MoveIndex = ReturnType<typeof indexMoveLines>

function layerAgrees(index: MoveIndex | undefined, key: string, layer: string): boolean {
    return !index?.itemLayers.has(key) || index.itemLayers.get(key) === layer
}

function selectMoveSuccessor(
    key: string,
    previous: MoveIndex | undefined,
    immediate: MoveIndex | undefined,
    current: MoveIndex,
    claimed: ReadonlyMap<string, number>,
): MoveLine | undefined {
    const old = previous?.items.get(key)
    if (old === null || previous?.ambiguous.has(key) || current.ambiguous.has(key)) return
    if (old?.layer && (!layerAgrees(immediate, key, old.layer) || !layerAgrees(current, key, old.layer))) {
        return
    }
    // A direct source ID can legitimately cross layers, for example when
    // undoing a layer merge. Only the inferred origin path needs a layer match.
    let candidates = current.successors.get(key)
    // A later move retains the original item ID. The prior incarnation
    // supplies the link, but only a unique same-layer successor proves it.
    if (
        !candidates && old?.origin && old.layer && !current.live.has(old.origin) &&
        !current.ambiguous.has(old.origin) && !previous?.ambiguous.has(old.origin) &&
        !claimed.has(old.origin)
    ) {
        const peers = previous?.successors.get(old.origin)?.filter((item) => item.layer === old.layer)
        if (peers?.length === 1) {
            candidates = current.successors.get(old.origin)?.filter((item) => item.layer === old.layer)
        }
    }
    if (candidates?.length !== 1) return
    const target = candidates[0]!
    const targetKey = itemRefKey(target.ref)
    if (!claimed.has(targetKey) && current.items.get(targetKey) === target) return target
}

function shapeTranslation(strokes: { before: Line | undefined; after: Line }[]): InkDelta | 'deformed' | null {
    let uniform: InkDelta | null = null
    let complete = true
    for (const { before, after } of strokes) {
        if (!before) {
            complete = false
            continue
        }
        if (
            before.thicknessScale !== after.thicknessScale ||
            before.points.length !== after.points.length
        ) {
            return 'deformed'
        }
        if (before.points.length === 0) complete = false
        for (let i = 0; i < before.points.length; i++) {
            const a = before.points[i]!
            const b = after.points[i]!
            if (a.width !== b.width) return 'deformed'
            const dx = b.x - a.x
            const dy = b.y - a.y
            uniform ??= { dx, dy }
            if (!(Math.abs(dx - uniform.dx) <= 1 && Math.abs(dy - uniform.dy) <= 1)) {
                return 'deformed'
            }
        }
    }
    return complete ? uniform : null
}

/**
 * xochitl MOVES an item as tombstone + re-add carrying moveId. Without this,
 * a device move of projected ink classifies as an ERASE: text gets truncated,
 * repairs revert live edits, and a whole-shape move dissolves the shape.
 * Rewrite each dead rendered ref to its live successor, including later moves
 * that retain the original item's ID.
 * An attached shape requires a live successor for every dead ref and a
 * uniform delta when prior geometry is available. Detached shapes keep
 * tracking identifiable strokes for reattachment without shifting position.
 * Mixed erases fall through to the erase classifier. A uniform delta shifts
 * the shape transform (overlay x/y are page px, deltas are ink units) and is
 * reported so views can follow. With no prior geometry, we rewrite refs
 * only for whole-shape moves. Partial selections and non-translation
 * transforms detach so the tablet's arrangement is visible.
 */
export function applyMoveRewrites(
    prev: RmDocument | null,
    doc: RmDocument,
    overlay: OverlayDocument,
    beforeSnapshot?: RmDocument | null,
): {
    changed: boolean
    moved: Map<string, InkDelta>
    detached: string[]
    rebindDetached: () => boolean
} {
    const moved = new Map<string, InkDelta>()
    const detached: string[] = []
    type Rewrite = { items: ItemRef[]; index: number; to: ItemRef; before: Line | undefined; after: Line }
    const pendingDetaches: { shape: OverlayShape; rewrites: Rewrite[] }[] = []
    const rebindDetached = () => {
        let changed = false
        for (const { shape, rewrites } of pendingDetaches) {
            // Move selection happened before erase handling changed ownership.
            if (shape.state !== 'detached') continue
            for (const r of rewrites) r.items[r.index] = r.to
            changed = true
        }
        return changed
    }
    const unchanged = { changed: false, moved, detached, rebindDetached }
    if (overlay.shapes.length === 0) return unchanged
    const hasMoves = doc.blocks.some(
        (block) => block.type === 'sceneLineItem' && block.deletedLength === 0 && block.line?.moveId,
    )
    if (!hasMoves) return unchanged
    const current = indexMoveLines(doc)
    if (current.successors.size === 0) return unchanged
    const claimed = new Map<string, number>()
    for (const shape of overlay.shapes) {
        for (const part of shape.rendered) {
            for (const ref of part.items) {
                const key = itemRefKey(ref)
                claimed.set(key, (claimed.get(key) ?? 0) + 1)
            }
        }
    }
    // Op replay can follow a snapshot that already tombstoned the source.
    // Prefer the immediate predecessor, with the pre-snapshot lines as backup.
    const previous = [prev, beforeSnapshot].flatMap((baseline) => baseline ? [indexMoveLines(baseline)] : [])
    const matches = new Map<string, { target: MoveLine; before: Line | undefined }>()
    const sourcesByTarget = new Map<string, string | null>()
    for (const [key, count] of claimed) {
        if (count !== 1 || current.live.has(key)) continue
        const baseline = previous.find((index) => index.items.has(key) || index.ambiguous.has(key))
        const target = selectMoveSuccessor(key, baseline, previous[0], current, claimed)
        if (!target) continue
        const targetKey = itemRefKey(target.ref)
        sourcesByTarget.set(targetKey, sourcesByTarget.has(targetKey) ? null : key)
        matches.set(key, { target, before: baseline?.items.get(key)?.line })
    }

    let changed = false
    for (const shape of overlay.shapes) {
        const rewrites: Rewrite[] = []
        let resolvable = true
        let hasUnmovedInk = false
        for (const part of shape.rendered) {
            for (let i = 0; i < part.items.length; i++) {
                const key = itemRefKey(part.items[i]!)
                if (current.live.has(key)) {
                    hasUnmovedInk = true
                    continue
                }
                const match = matches.get(key)
                if (!match || sourcesByTarget.get(itemRefKey(match.target.ref)) !== key) {
                    resolvable = false
                    continue
                }
                // An old detached tombstone alone does not establish who
                // owned the stroke at the time of a cold or subsequent pull.
                if (shape.state === 'detached' && !match.before) continue
                rewrites.push({
                    items: part.items,
                    index: i,
                    to: match.target.ref,
                    before: match.before,
                    after: match.target.line,
                })
            }
        }
        if (rewrites.length === 0) continue
        if (!resolvable && shape.state !== 'detached') {
            pendingDetaches.push({ shape, rewrites })
            continue
        }
        // Keep the successor refs so reattaching can replace the moved ink.
        for (const r of rewrites) r.items[r.index] = r.to
        changed = true
        if (shape.state === 'detached') continue
        const uniform = shapeTranslation(rewrites)
        if (hasUnmovedInk || uniform === 'deformed') {
            shape.state = 'detached'
            detached.push(shape.shapeId)
            continue
        }
        if (uniform && (uniform.dx !== 0 || uniform.dy !== 0)) {
            shape.x += uniform.dx * RM_SCALE
            shape.y += uniform.dy * RM_SCALE
            moved.set(shape.shapeId, uniform)
        }
    }
    return { changed, moved, detached, rebindDetached }
}

const GLYPH_KEY = /^glyph:(\d+)$/

/**
 * D8 text-repair policy. A clean glyph erase only maps back to a *semantic*
 * text edit when the erased glyphs are the CONTIGUOUS TRAILING SUFFIX of the
 * shape (tail truncation: "abcd" − "d" ⇒ "abc"). A hole in the middle
 * ("abcd" − "c" ⇒ the tablet shows "ab d" with a gap) has no unambiguous
 * reflow: "abd" would not match the surviving ink positions. Per D8 that case
 * DETACHES (frozen + surfaced) rather than silently reflowing.
 *
 * Returns the removed glyph indices ONLY when they are all glyph parts, at
 * least one, and form the exact trailing run {n−k … n−1} where n is the shape's
 * glyph-part count. Otherwise `null` ⇒ the caller detaches.
 */
export function trailingGlyphErase(shape: OverlayShape, fullyErasedParts: string[]): number[] | null {
    if (shape.kind !== 'text') return null
    const removed: number[] = []
    for (const key of fullyErasedParts) {
        const m = GLYPH_KEY.exec(key)
        if (!m) return null // a non-glyph part erased alongside glyphs ⇒ not a clean text edit
        removed.push(Number(m[1]))
    }
    if (removed.length === 0) return null

    // Glyph indices are SOURCE-TEXT indices, not ordinals: whitespace produces
    // no part but still advances the numbering ("ab cd" renders parts
    // 0,1,3,4). "Trailing" therefore means the erased set equals the LAST k
    // indices actually present on the shape — the old {n−k…n−1}-of-the-COUNT
    // check spuriously DETACHED any spaced text's tail erase.
    const present = shape.rendered
        .filter((p) => GLYPH_KEY.test(p.partKey))
        .map((p) => Number(GLYPH_KEY.exec(p.partKey)![1]))
        .sort((a, b) => a - b)
    if (present.length === 0) return null
    removed.sort((a, b) => a - b)
    const tail = present.slice(-removed.length)
    for (let i = 0; i < removed.length; i++) {
        if (removed[i] !== tail[i]) return null // gap or non-suffix ⇒ detach
    }
    return removed
}

/**
 * Overlay-vs-document audit. The event-driven reconcile() only sees CHANGES;
 * this checks ABSOLUTE consistency and must run at session open and after
 * every remote pull — a page can change while no session is watching, and a
 * 'repair' patch is ephemeral (if the view dies before re-rendering, the
 * overlay keeps live shapes whose items are all tombstones).
 */
export function auditOverlay(doc: RmDocument, overlay: OverlayDocument): AuditDecision[] {
    const { live } = collectItemRefs(doc)
    const decisions: AuditDecision[] = []

    for (const shape of overlay.shapes) {
        if (shape.state === 'detached') continue
        const fullyGone: string[] = []
        let partiallyGone = false
        let intactParts = 0
        for (const part of shape.rendered) {
            // absent counts as gone too: xochitl may compact old tombstones
            const liveCount = part.items.filter((i) => live.has(itemRefKey(i))).length
            if (liveCount === part.items.length) intactParts++
            else if (liveCount === 0) fullyGone.push(part.partKey)
            else partiallyGone = true
        }
        if (fullyGone.length === 0 && !partiallyGone) continue

        if (intactParts === 0 && !partiallyGone) {
            decisions.push({ type: 'remove', shapeId: shape.shapeId })
            continue
        }
        if (partiallyGone) {
            decisions.push({ type: 'detach', shapeId: shape.shapeId })
            continue
        }
        // D8: only a contiguous TRAILING glyph erase repairs; a middle hole
        // detaches (see trailingGlyphErase).
        const trailing = trailingGlyphErase(shape, fullyGone)
        if (trailing) {
            decisions.push({
                type: 'repair',
                shapeId: shape.shapeId,
                edit: { kind: 'text-truncate-glyphs', removedGlyphIndices: trailing },
            })
            continue
        }
        decisions.push({ type: 'detach', shapeId: shape.shapeId })
    }
    return decisions
}

export function reconcile(diff: PageDiff, overlay: OverlayDocument): AuditDecision[] {
    const decisions: AuditDecision[] = []
    for (const hit of diff.overlayHits) {
        const shape = overlay.shapes.find((s) => s.shapeId === hit.shapeId)
        if (!shape || shape.state === 'detached') continue

        // Whole shape gone: every part fully erased, none partial. The tablet
        // deleted or moved the entire shape (a move = tombstone + re-create
        // under xochitl's author). Dissolve it, mirroring auditOverlay. Must
        // precede the text-repair branch below, or a whole-shape move
        // degenerates into an empty all-glyphs-removed repair.
        if (
            hit.partiallyErasedParts.length === 0 &&
            shape.rendered.length > 0 &&
            hit.fullyErasedParts.length === shape.rendered.length
        ) {
            decisions.push({ type: 'remove', shapeId: hit.shapeId })
            continue
        }

        // Partial erase within any sub-part => ambiguous => detach (visible,
        // never silent — the UI offers re-attach / convert).
        if (hit.partiallyErasedParts.length > 0) {
            decisions.push({ type: 'detach', shapeId: hit.shapeId })
            continue
        }

        // Clean TRAILING glyph erase on text => semantic repair (ABCD -> ABC).
        // A middle-glyph hole is ambiguous (no reflow matches the surviving
        // ink) and detaches instead — trailingGlyphErase enforces D8.
        const trailing = trailingGlyphErase(shape, hit.fullyErasedParts)
        if (trailing) {
            decisions.push({
                type: 'repair',
                shapeId: hit.shapeId,
                edit: { kind: 'text-truncate-glyphs', removedGlyphIndices: trailing },
            })
            continue
        }

        // Any other clean erase (middle-glyph hole, arrowhead, contour, ...) =>
        // per-kind repair policies plug in here.
        decisions.push({ type: 'detach', shapeId: hit.shapeId })
    }
    return decisions
}
