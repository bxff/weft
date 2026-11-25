/**
 * Scene item model: lines (strokes), groups (layers), text, glyph highlights.
 */

import type { CrdtId, LwwValue } from './crdt-id'
import type { CrdtSequence, CrdtSequenceItem } from './crdt-sequence'

export enum PenColor {
    BLACK = 0,
    GRAY = 1,
    WHITE = 2,
    YELLOW = 3,
    GREEN = 4,
    PINK = 5,
    BLUE = 6,
    RED = 7,
    GRAY_OVERLAP = 8,
    HIGHLIGHT = 9,
    GREEN_2 = 10,
    CYAN = 11,
    MAGENTA = 12,
    YELLOW_2 = 13,
}

export enum Pen {
    PAINTBRUSH_1 = 0,
    PENCIL_1 = 1,
    BALLPOINT_1 = 2,
    MARKER_1 = 3,
    FINELINER_1 = 4,
    HIGHLIGHTER_1 = 5,
    ERASER = 6,
    MECHANICAL_PENCIL_1 = 7,
    ERASER_AREA = 8,
    PAINTBRUSH_2 = 12,
    PENCIL_2 = 13,
    BALLPOINT_2 = 14,
    MECHANICAL_PENCIL_2 = 15,
    MARKER_2 = 16,
    FINELINER_2 = 17,
    HIGHLIGHTER_2 = 18,
    CALLIGRAPHY = 21,
    SHADER = 23,
}

export enum ParagraphStyle {
    BASIC = 0,
    PLAIN = 1,
    HEADING = 2,
    BOLD = 3,
    BULLET = 4,
    BULLET2 = 5,
    CHECKBOX = 6,
    CHECKBOX_CHECKED = 7,
}

/**
 * One stroke sample. Units are the v6 wire encoding:
 * speed/width uint16, direction/pressure uint8, x/y float32 page coords.
 */
export interface Point {
    x: number
    y: number
    speed: number
    direction: number
    width: number
    pressure: number
}

export interface Line {
    readonly kind: 'line'
    color: PenColor
    tool: Pen
    points: Point[]
    thicknessScale: number
    startingLength: number
    /** Timestamp id as stored on the wire (kept for byte-exact round-trip). */
    timestamp: CrdtId
    moveId: CrdtId | null
}

export interface Group {
    readonly kind: 'group'
    nodeId: CrdtId
    children: CrdtSequence<SceneItem>
    label: LwwValue<string> | null
    visible: LwwValue<boolean> | null
    anchorId: LwwValue<CrdtId> | null
    anchorType: LwwValue<number> | null
    anchorThreshold: LwwValue<number> | null
    anchorOriginX: LwwValue<number> | null
}

/** A paragraph-style LWW entry. Newer firmware appends optional tagged
 *  fields after the style byte (Byte1 at index 2, Byte4 at index 3, text
 *  sizing), preserved verbatim in `extra` for byte-exact round-trips. */
export interface TextStyleValue extends LwwValue<number> {
    /** Raw bytes after the style value inside the subblock (may be empty). */
    extra?: Uint8Array
}

export interface Text {
    readonly kind: 'text'
    /** Sequence of string fragments and formatting codes. */
    items: CrdtSequence<string | number>
    /** Paragraph style per anchor char id (key = crdtIdKey). Values beyond
     *  ParagraphStyle (e.g. 10 = numbered list) pass through as numbers. */
    styles: Map<string, TextStyleValue>
    posX: number
    posY: number
    width: number
}

export interface Rectangle {
    x: number
    y: number
    w: number
    h: number
}

export interface GlyphRange {
    readonly kind: 'glyphRange'
    start: number | null
    length: number
    text: string
    color: PenColor
    rectangles: Rectangle[]
}

/**
 * Embedded image (firmware 3.27+, blocks 0x0E/0x0F). Pixel bytes live in a
 * sibling asset file (`<uuid>.png`/`.jpg`) next to the page .rm; the scene
 * item carries only placement.
 */
export interface Image {
    readonly kind: 'image'
    /** 16-byte asset uuid exactly as stored (LE); see `imageAssetUuid()`. */
    uuid: LwwValue<Uint8Array>
    /** Wire field 2 (rmscene calls it move_id). */
    timestamp: CrdtId
    /** 4 corners x (x, y, u, v): TL, TR, BR, BL. */
    vertices: number[]
    /** Quad triangulation indices; observed [0, 1, 2, 2, 3, 0]. */
    indices: number[]
    /** Asset filename resolved from the SceneImageInfo block at tree build. */
    filename: string | null
}

export type SceneItem = Line | Group | Text | GlyphRange | Image

export const isLine = (i: SceneItem | null | undefined): i is Line => i?.kind === 'line'
export const isGroup = (i: SceneItem | null | undefined): i is Group => i?.kind === 'group'
export const isText = (i: SceneItem | null | undefined): i is Text => i?.kind === 'text'
export const isGlyphRange = (i: SceneItem | null | undefined): i is GlyphRange =>
    i?.kind === 'glyphRange'
export const isImage = (i: SceneItem | null | undefined): i is Image => i?.kind === 'image'

export type { CrdtSequenceItem }
