/**
 * Simulate the reMarkable tablet erasing ink items from a page's `.rm`, for
 * browser e2e: parse -> tombstone the named items -> normalizeLayout
 * (xochitl rewrites layout on erase) -> serialize. Caller PUTs the result
 * back with a device token so the store emits `page.changed` with
 * `originClientId: null`, as a real tablet write would.
 *
 * Depends only on `@weft/rm-format`, via dynamic import() of the package
 * `src` (same form as app.spec.ts). Avoid `@weft/sync-engine`: importing that
 * barrel gives rm-format a second module identity under Playwright's
 * per-file transform, so the ref<->id resolution is inlined instead
 * (mirrors RefResolver.toId).
 */

/** A file-local reference to an ink item (author uuid + logical clock). */
export interface ItemRef {
    authorUuid: string
    clock: number
}

/** Tombstone the given items in `.rm` bytes and re-serialize (the tablet path). */
export async function eraseItemsInRm(bytes: Uint8Array, items: ItemRef[]): Promise<Uint8Array> {
    const { RmDocument, crdtId } = await import('../packages/rm-format/src/index')
    const doc = RmDocument.parse(bytes)
    // author uuid -> file-local index (RefResolver.toId inverse)
    const byUuid = new Map<string, number>()
    for (const [index, uuid] of doc.authorTable()) byUuid.set(uuid.toLowerCase(), index)

    for (const ref of items) {
        const index = byUuid.get(ref.authorUuid.toLowerCase())
        if (index === undefined) throw new Error(`unknown author ${ref.authorUuid}`)
        const id = crdtId(index, ref.clock)
        if (!doc.tombstone(id)) throw new Error(`tombstone failed for ${ref.authorUuid}:${ref.clock}`)
    }
    doc.normalizeLayout()
    return doc.serialize()
}

/** The overlay shape shape returned by GET /overlay (the repair substrate). */
export interface OverlayShapeJson {
    shapeId: string
    kind: string
    state: 'live' | 'detached'
    rendered: { partKey: string; items: ItemRef[] }[]
}
