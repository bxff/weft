/**
 * A moved embedded image is tombstoned + re-appended (device-native pattern),
 * so its CRDT item id and file order change. Rebind by asset UUID, not file
 * order, since order is unstable once a page has more than one image.
 */

export interface LiveImage {
    /** asset uuid of the live image item (lower-cased) */
    uuid: string
    /** itemRef key the shape should now be bound to */
    refKey: string
}

/** Maps live image items to shapeIds via the stale uuid→shapeId bindings.
 *  Images with an unknown uuid (e.g. inserted on the tablet) are left unbound. */
export function remapImagesByUuid(
    live: LiveImage[],
    staleShapesByUuid: Map<string, string>,
): Map<string, string> {
    const out = new Map<string, string>()
    for (const { uuid, refKey } of live) {
        const shapeId = staleShapesByUuid.get(uuid.toLowerCase())
        if (shapeId) out.set(refKey, shapeId)
    }
    return out
}
