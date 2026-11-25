/**
 * Engine model types. Author numbers are file-local: everything persisted
 * refers to items as {authorUuid, clock} and resolves numeric ids per document.
 */

export interface ItemRef {
    authorUuid: string
    clock: number
}

export function itemRefKey(ref: ItemRef): string {
    return `${ref.authorUuid.toLowerCase()}:${ref.clock}`
}

export interface RenderedPart {
    /** Stable sub-part key, e.g. 'glyph:3', 'contour:2', 'whole'. */
    partKey: string
    items: ItemRef[]
    /** Hash of the projected stroke geometry (idempotence check). */
    contentHash: string
}

export type OverlayShapeKind = 'text' | 'geo' | 'arrow' | 'line' | 'draw-native'

/**
 * Wall-clock LWW version. `ts` = client wall-clock ms at edit time, `actor` =
 * the minting clientId. Concurrent edits to the same object id converge on
 * the higher `ts`, ties broken on the higher `actor` string. Total order
 * lives in ops.ts (`compareVersion`).
 */
export interface OpVersion {
    ts: number
    actor: string
}

export interface OverlayShape {
    /** tldraw shape id — minted once, stable across reloads. */
    shapeId: string
    kind: OverlayShapeKind
    /** Full tldraw props snapshot (semantic source of truth). */
    props: unknown
    x: number
    y: number
    rotation: number
    /** Browser shape opacity. Legacy records may omit it. */
    opacity?: number
    /** Version of the explicit opacity write, when different from the shape version. */
    opacityVersion?: OpVersion
    /** Fractional paint order for a page-root browser shape. */
    browserIndex?: string
    /** Independent order clock. Older records use the shape version. */
    browserIndexVersion?: OpVersion
    rendered: RenderedPart[]
    /** Hash of (props,x,y,rotation) that produced `rendered`. */
    renderRevision: string
    state: 'live' | 'detached'
    /** Wall-clock LWW version of the edit that produced this shape. */
    version: OpVersion
}

export interface OverlayDocument {
    /** Live (renderable) shapes, keyed by shapeId. */
    shapes: OverlayShape[]
    /**
     * Last delete per shape id. Only a newer upsert can recreate the shape.
     * Retain the boundary after recreation so late metadata writes from the
     * previous lifetime cannot modify the new shape.
     */
    tombstones?: Record<string, OpVersion>
}

export const EMPTY_OVERLAY: OverlayDocument = { shapes: [] }

// --- change classification (differ output) ---

export interface PageDiff {
    /** New non-tombstoned items not owned by any overlay shape: tablet ink. */
    foreignAdds: ItemRef[]
    /** Items that became tombstoned and belong to no overlay shape. */
    foreignDeletes: ItemRef[]
    /** Tombstoned items that belong to an overlay shape, grouped per shape. */
    overlayHits: Array<{
        shapeId: string
        /** partKeys whose items are ALL tombstoned. */
        fullyErasedParts: string[]
        /** partKeys with some (not all) items tombstoned. */
        partiallyErasedParts: string[]
    }>
}

// --- engine -> view patches ---

export type ViewPatch =
    | { type: 'ink-added'; items: ItemRef[] }
    | { type: 'ink-removed'; items: ItemRef[] }
    | { type: 'shape-edited'; shapeId: string; edit: ShapeEdit }
    | { type: 'shape-detached'; shapeId: string }
    /** The tablet MOVED the shape's ink as a block (uniform delta, ink
     *  units): the view should shift the shape to match. */
    | { type: 'shape-moved'; shapeId: string; dx: number; dy: number }
    /** The tablet deleted or moved ALL of a shape's ink: the shape is gone;
     *  any moved ink arrives separately as foreign strokes. */
    | { type: 'shape-removed'; shapeId: string }
    /** A foreign weft client added or replaced a semantic shape (op-mode
     *  overlay merge): the view should render/refresh it from `shape`. */
    | { type: 'shape-upserted'; shape: OverlayShape }
    | { type: 'document-replaced' }

export type ShapeEdit = { kind: 'text-truncate-glyphs'; removedGlyphIndices: number[] }

// --- errors (tagged union; maps 1:1 to Effect tagged errors at the boundary) ---

export type EngineError =
    | { _tag: 'DeviceUnreachable'; cause: string }
    | { _tag: 'StaleRevision'; currentRevision: string }
    | { _tag: 'PageMissing'; doc: string; page: string }
    | { _tag: 'StoreCorrupt'; cause: string }
    | { _tag: 'Unauthorized' }
    /** The relay truncated ops the client's cursor still needs (HTTP 410 on
     *  /ops): `floorSeq` is the highest truncated-away op seq. Recovery =
     *  re-bootstrap (snapshot + replay from its op cursor), not a plain pull. */
    | { _tag: 'OpsTruncated'; floorSeq: number }
    | { _tag: 'CheckpointChanged'; snapshotSeq: number }

export class EngineFailure extends Error {
    constructor(readonly error: EngineError) {
        super(error._tag)
    }
}

// --- telemetry (opt-in failure reporting; redacted by construction) ---

/**
 * Failure report emitted when sync breaks. Carries no note content (no .rm
 * bytes, overlay/tldraw props, ink geometry, page text, filenames, or tokens);
 * doc/page are opaque ids the caller may hash. Sent only when opted in (default off).
 */
export interface FailureReport {
    /** coarse area that failed */
    kind: 'engine' | 'codec' | 'reconcile' | 'guardrail'
    /** EngineError._tag, codec error name, or a short stable label */
    tag: string
    /** bounded, redacted human message (never note content) */
    message: string
    /** opaque document id (caller may hash before sending) */
    doc: string
    /** opaque page id (caller may hash before sending) */
    page: string
    /** small non-sensitive context: pending op count, attempt, durations… */
    context?: Record<string, string | number | boolean>
    /** client clock (ms since epoch) */
    occurredAt: number
}
