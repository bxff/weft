/** Batch op codec — TEST-ONLY convenience. The wire ships per-op
 *  encodeOp/decodeOp; nothing in production batches ops into one blob. */
import type { Op } from '../src/ops'

export function encodeOps(ops: Op[]): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(ops))
}

export function decodeOps(bytes: Uint8Array): Op[] {
    return JSON.parse(new TextDecoder().decode(bytes)) as Op[]
}
