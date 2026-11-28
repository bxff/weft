/**
 * Snapshot container: the whole compacted .rm (+ overlay). The relay stores
 * snapshot bytes opaquely, so the client frames both layers into one blob and
 * unframes on bootstrap.
 *
 * Wire layout (little-endian): [u32 rmLen][rm bytes][overlay JSON utf-8].
 * Magic + version guard a future format change and reject a raw .rm (no
 * header) being mistaken for a container.
 */

import type { OverlayDocument } from './types'

const MAGIC = 0x57464e53 // 'WFNS' (weft snapshot)
const VERSION = 1
const HEADER = 12 // magic(4) + version(4) + rmLen(4)

export function encodeSnapshot(rm: Uint8Array, overlay: OverlayDocument): Uint8Array {
    const overlayBytes = new TextEncoder().encode(JSON.stringify(overlay))
    const out = new Uint8Array(HEADER + rm.length + overlayBytes.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, MAGIC, true)
    view.setUint32(4, VERSION, true)
    view.setUint32(8, rm.length, true)
    out.set(rm, HEADER)
    out.set(overlayBytes, HEADER + rm.length)
    return out
}

export function decodeSnapshot(bytes: Uint8Array): { rm: Uint8Array; overlay: OverlayDocument } {
    if (bytes.length < HEADER) throw new Error('decodeSnapshot: truncated header')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.getUint32(0, true) !== MAGIC) throw new Error('decodeSnapshot: bad magic')
    const version = view.getUint32(4, true)
    if (version !== VERSION) throw new Error(`decodeSnapshot: unsupported version ${version}`)
    const rmLen = view.getUint32(8, true)
    if (HEADER + rmLen > bytes.length) throw new Error('decodeSnapshot: rmLen exceeds buffer')
    const rm = bytes.slice(HEADER, HEADER + rmLen)
    const overlayBytes = bytes.slice(HEADER + rmLen)
    const overlay =
        overlayBytes.length === 0
            ? { shapes: [] }
            : (JSON.parse(new TextDecoder().decode(overlayBytes)) as OverlayDocument)
    return { rm, overlay }
}

export const SNAPSHOT_BATCH_CONTENT_TYPE = 'application/vnd.weft.snapshot-batch'

export interface SnapshotBatch {
    snapshot: Uint8Array
    deltas: Uint8Array[]
    author: string
}

const BATCH_HEADER = 5

/** A guarded publication may include its already-minted history deltas. */
export function encodeSnapshotBatch(batch: SnapshotBatch): Uint8Array {
    const lengths = batch.deltas.map((delta) => delta.byteLength)
    const header = new TextEncoder().encode(JSON.stringify({ lengths, author: batch.author }))
    const size = BATCH_HEADER + header.byteLength + lengths.reduce((sum, length) => sum + length, 0)
    const bytes = new Uint8Array(size + batch.snapshot.byteLength)
    bytes[0] = 1
    new DataView(bytes.buffer).setUint32(1, header.byteLength, true)
    bytes.set(header, BATCH_HEADER)
    let offset = BATCH_HEADER + header.byteLength
    for (const delta of batch.deltas) {
        bytes.set(delta, offset)
        offset += delta.byteLength
    }
    bytes.set(batch.snapshot, offset)
    return bytes
}

export function decodeSnapshotBatch(bytes: Uint8Array): SnapshotBatch {
    if (bytes.byteLength < BATCH_HEADER || bytes[0] !== 1) throw new Error('Invalid snapshot batch header')
    const headerSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true)
    let offset = BATCH_HEADER + headerSize
    if (offset >= bytes.byteLength) throw new Error('Truncated snapshot batch header')
    const { author, lengths } = JSON.parse(new TextDecoder().decode(bytes.subarray(BATCH_HEADER, offset))) as {
        author: unknown
        lengths: unknown
    }
    if (typeof author !== 'string' || !Array.isArray(lengths)) throw new Error('Invalid snapshot batch metadata')
    const deltas = lengths.map((size) => {
        if (!Number.isSafeInteger(size) || size < 1 || offset + size >= bytes.byteLength) {
            throw new Error('Truncated snapshot batch delta')
        }
        const delta = bytes.subarray(offset, offset + size)
        offset += size
        return delta
    })
    return { snapshot: bytes.subarray(offset), deltas, author }
}
