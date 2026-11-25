/**
 * CRDT identifiers and LWW values for the reMarkable v6 format.
 *
 * A CrdtId is (part1, part2) where part1 is a FILE-LOCAL author index and part2
 * is that author's clock. xochitl renumbers author indices on rewrite: only the
 * UUID in the AuthorIds table is a stable identity. Never persist bare part1
 * values outside a single file read.
 */

export interface CrdtId {
    readonly part1: number
    readonly part2: number
}

export const END_MARKER: CrdtId = { part1: 0, part2: 0 }

export function crdtId(part1: number, part2: number): CrdtId {
    return { part1, part2 }
}

export function crdtIdEquals(a: CrdtId, b: CrdtId): boolean {
    return a.part1 === b.part1 && a.part2 === b.part2
}

/** Numeric ordering by (author index, clock). */
export function crdtIdCompare(a: CrdtId, b: CrdtId): number {
    return a.part1 - b.part1 || a.part2 - b.part2
}

/** Stable map key. Format is internal; do not parse. */
export function crdtIdKey(id: CrdtId): string {
    return `${id.part1}:${id.part2}`
}

export function isEndMarker(id: CrdtId): boolean {
    return id.part1 === 0 && id.part2 === 0
}

/** Last-write-wins register value. */
export interface LwwValue<T> {
    readonly timestamp: CrdtId
    readonly value: T
}

export function lww<T>(timestamp: CrdtId, value: T): LwwValue<T> {
    return { timestamp, value }
}

/** Sentinel anchor ids (text anchoring): a group anchored to these tracks
 *  the START (above the first line) or END (below the last line) of the
 *  root text rather than a specific character. Values are 2^48-2 / 2^48-1
 *  in author slot 0, matching xochitl. */
export const ANCHOR_TEXT_START: CrdtId = crdtId(0, 281474976710654)
export const ANCHOR_TEXT_END: CrdtId = crdtId(0, 281474976710655)

/** Clocks at or above this value are RESERVED sentinels (the text anchors
 *  above), NOT real Lamport clocks. Any clock arithmetic that scans stored
 *  ids — e.g. maxClock — MUST ignore this range, or a page with anchored
 *  text mints new ids at 2^48+ (overflowing the 48-bit clock field and never
 *  stabilising across an .rm round-trip → runaway re-adds). */
export const RESERVED_CLOCK_FLOOR = 281474976710654 // 2^48 - 2 (ANCHOR_TEXT_START)
