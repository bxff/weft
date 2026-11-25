/** Diffs by item identity, not timing (ARCHITECTURE §3). Pure function. */

import type { RmDocument } from '@weft/rm-format'
import { collectItemRefs } from './refs'
import { itemRefKey, type OverlayDocument, type PageDiff, type ItemRef } from './types'

export interface KnownState {
    /** itemRefKey -> ref for items we have already processed (live). */
    live: Map<string, ItemRef>
    /** itemRefKey set of items we already know are tombstoned. */
    dead: Set<string>
}


export function snapshotKnownState(doc: RmDocument): KnownState {
    const { live, dead } = collectItemRefs(doc)
    return { live, dead: new Set(dead.keys()) }
}

/** Which overlay shape/part owns each item. */
function buildOwnership(overlay: OverlayDocument): Map<string, { shapeId: string; partKey: string }> {
    const owners = new Map<string, { shapeId: string; partKey: string }>()
    for (const shape of overlay.shapes) {
        if (shape.state === 'detached') continue
        for (const part of shape.rendered) {
            for (const item of part.items) {
                owners.set(itemRefKey(item), { shapeId: shape.shapeId, partKey: part.partKey })
            }
        }
    }
    return owners
}

export function diffPage(known: KnownState, doc: RmDocument, overlay: OverlayDocument): PageDiff {
    const { live, dead } = collectItemRefs(doc)
    const owners = buildOwnership(overlay)

    const foreignAdds: ItemRef[] = []
    for (const [key, ref] of live) {
        if (!known.live.has(key) && !known.dead.has(key) && !owners.has(key)) {
            foreignAdds.push(ref)
        }
    }

    const foreignDeletes: ItemRef[] = []
    const hitParts = new Map<string, Set<string>>() // shapeId -> partKeys hit
    for (const [key, ref] of dead) {
        if (known.dead.has(key)) continue // already processed
        const owner = owners.get(key)
        if (!owner) {
            if (known.live.has(key)) foreignDeletes.push(ref)
            continue
        }
        let parts = hitParts.get(owner.shapeId)
        if (!parts) {
            parts = new Set()
            hitParts.set(owner.shapeId, parts)
        }
        parts.add(owner.partKey)
    }

    // Classify hit parts as fully or partially erased
    const overlayHits: PageDiff['overlayHits'] = []
    for (const [shapeId, parts] of hitParts) {
        const shape = overlay.shapes.find((s) => s.shapeId === shapeId)
        if (!shape) continue
        const fully: string[] = []
        const partially: string[] = []
        for (const partKey of parts) {
            const part = shape.rendered.find((p) => p.partKey === partKey)
            if (!part) continue
            const allDead = part.items.every((item) => dead.has(itemRefKey(item)))
            if (allDead) fully.push(partKey)
            else partially.push(partKey)
        }
        overlayHits.push({ shapeId, fullyErasedParts: fully, partiallyErasedParts: partially })
    }

    return { foreignAdds, foreignDeletes, overlayHits }
}
