/**
 * ItemRef <-> CrdtId resolution against a specific document's author table.
 */

import { type CrdtId, type RmDocument, crdtId } from '@weft/rm-format'
import { type ItemRef, itemRefKey } from './types'

export class RefResolver {
    private byIndex: Map<number, string>
    private byUuid: Map<string, number>

    constructor(doc: RmDocument) {
        this.byIndex = new Map(doc.authorTable())
        this.byUuid = new Map(
            [...this.byIndex].map(([index, uuid]) => [uuid.toLowerCase(), index]),
        )
    }

    toRef(id: CrdtId): ItemRef | null {
        const uuid = this.byIndex.get(id.part1)
        if (!uuid) return null
        return { authorUuid: uuid.toLowerCase(), clock: id.part2 }
    }

    toId(ref: ItemRef): CrdtId | null {
        const index = this.byUuid.get(ref.authorUuid.toLowerCase())
        if (index === undefined) return null
        return crdtId(index, ref.clock)
    }
}

/** All line-item refs in a document, split by tombstone state. */
export function collectItemRefs(doc: RmDocument): {
    live: Map<string, ItemRef>
    dead: Map<string, ItemRef>
} {
    const resolver = new RefResolver(doc)
    const live = new Map<string, ItemRef>()
    const dead = new Map<string, ItemRef>()
    for (const block of doc.blocks) {
        if (
            block.type !== 'sceneLineItem' &&
            block.type !== 'sceneGlyphItem' &&
            block.type !== 'sceneTombstoneItem' &&
            block.type !== 'sceneImageItem'
        ) {
            continue
        }
        const ref = resolver.toRef(block.itemId)
        if (!ref) continue
        const key = itemRefKey(ref)
        if (block.deletedLength > 0) dead.set(key, ref)
        else live.set(key, ref)
    }
    return { live, dead }
}
