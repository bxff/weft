/**
 * Tagged block layer: framing, tagged values, LWW values, strings.
 *
 * Unread trailing bytes in a block or subblock are returned to the caller
 * (not dropped), so unknown fields from newer firmware round-trip byte-exact.
 */

import { DataStream, TagType, UnexpectedTagError, EofError } from './bytes'
import { type CrdtId, type LwwValue, lww } from './crdt-id'

export interface BlockHeader {
    offset: number
    size: number
    blockType: number
    minVersion: number
    currentVersion: number
}

export class BlockOverflowError extends Error {
    override name = 'BlockOverflowError'
}

const EMPTY = new Uint8Array(0)

export class TaggedBlockReader {
    readonly data: DataStream
    private block: BlockHeader | null = null
    private subblockEnds: number[] = []

    constructor(data: ArrayBuffer | Uint8Array) {
        this.data = new DataStream(data)
    }

    readHeader(): void {
        this.data.readHeader()
    }

    /** Read the next block header, or null at EOF. */
    readBlockHeader(): BlockHeader | null {
        if (this.block) throw new Error('already in a block')
        try {
            const size = this.data.readUint32()
            const unknown = this.data.readUint8()
            if (unknown !== 0) throw new Error(`block header unknown byte = ${unknown}`)
            const minVersion = this.data.readUint8()
            const currentVersion = this.data.readUint8()
            const blockType = this.data.readUint8()
            this.block = { offset: this.data.tell(), size, blockType, minVersion, currentVersion }
            return this.block
        } catch (e) {
            if (e instanceof EofError) return null
            throw e
        }
    }

    /** Finish the current block; returns any unread trailing bytes. */
    endBlock(): Uint8Array {
        if (!this.block) throw new Error('not in a block')
        const extra = this.consumeTo(this.block.offset + this.block.size)
        this.block = null
        return extra
    }

    bytesRemainingInBlock(): number {
        if (!this.block) throw new Error('not in a block')
        return this.block.offset + this.block.size - this.data.tell()
    }

    /** Skip the whole current block body, returning its raw bytes. */
    readRawBlockBody(): Uint8Array {
        if (!this.block) throw new Error('not in a block')
        this.data.seek(this.block.offset)
        return this.data.readBytes(this.block.size)
    }

    private consumeTo(end: number): Uint8Array {
        const pos = this.data.tell()
        if (pos > end) {
            throw new BlockOverflowError(`read ${pos - end} bytes past boundary at ${end}`)
        }
        return pos < end ? this.data.readBytes(end - pos) : EMPTY
    }

    // --- subblocks ---

    hasSubblock(index: number): boolean {
        const limit = this.subblockEnds.length
            ? this.subblockEnds[this.subblockEnds.length - 1]!
            : this.block
              ? this.block.offset + this.block.size
              : Infinity
        if (this.data.tell() >= limit) return false
        return this.data.checkTag(index, TagType.Length4)
    }

    /** Enter a subblock: reads tag + length. Pair with endSubblock(). */
    beginSubblock(index: number): void {
        this.data.readTag(index, TagType.Length4)
        const size = this.data.readUint32()
        this.subblockEnds.push(this.data.tell() + size)
    }

    /** Bytes remaining in the innermost subblock. */
    subblockBytesRemaining(): number {
        const end = this.subblockEnds[this.subblockEnds.length - 1]
        if (end === undefined) throw new Error('not in a subblock')
        return end - this.data.tell()
    }

    /** Leave the innermost subblock; returns unread trailing bytes. */
    endSubblock(): Uint8Array {
        const end = this.subblockEnds.pop()
        if (end === undefined) throw new Error('not in a subblock')
        return this.consumeTo(end)
    }

    /** Read an entire subblock through `fn`, asserting full consumption. */
    subblock<T>(index: number, fn: () => T): T {
        this.beginSubblock(index)
        const result = fn()
        const extra = this.endSubblock()
        if (extra.length > 0) {
            throw new BlockOverflowError(`subblock ${index} had ${extra.length} unread bytes`)
        }
        return result
    }

    // --- tagged scalar values ---

    readId(index: number): CrdtId {
        this.data.readTag(index, TagType.ID)
        return this.data.readCrdtId()
    }

    readBool(index: number): boolean {
        this.data.readTag(index, TagType.Byte1)
        return this.data.readBool()
    }

    readByte(index: number): number {
        this.data.readTag(index, TagType.Byte1)
        return this.data.readUint8()
    }

    readInt(index: number): number {
        this.data.readTag(index, TagType.Byte4)
        return this.data.readUint32()
    }

    readFloat(index: number): number {
        this.data.readTag(index, TagType.Byte4)
        return this.data.readFloat32()
    }

    readDouble(index: number): number {
        this.data.readTag(index, TagType.Byte8)
        return this.data.readFloat64()
    }

    private optional<T>(read: (index: number) => T, index: number): T | null {
        try {
            return read.call(this, index)
        } catch (e) {
            if (e instanceof UnexpectedTagError || e instanceof EofError) return null
            throw e
        }
    }

    readIdOptional(index: number): CrdtId | null {
        return this.optional(this.readId, index)
    }
    readBoolOptional(index: number): boolean | null {
        return this.optional(this.readBool, index)
    }
    readIntOptional(index: number): number | null {
        return this.optional(this.readInt, index)
    }

    // --- composite values ---

    readLwwBool(index: number): LwwValue<boolean> {
        return this.subblock(index, () => {
            const timestamp = this.readId(1)
            return lww(timestamp, this.readBool(2))
        })
    }

    readLwwByte(index: number): LwwValue<number> {
        return this.subblock(index, () => {
            const timestamp = this.readId(1)
            return lww(timestamp, this.readByte(2))
        })
    }

    readLwwFloat(index: number): LwwValue<number> {
        return this.subblock(index, () => {
            const timestamp = this.readId(1)
            return lww(timestamp, this.readFloat(2))
        })
    }

    readLwwId(index: number): LwwValue<CrdtId> {
        return this.subblock(index, () => {
            const timestamp = this.readId(1)
            return lww(timestamp, this.readId(2))
        })
    }

    readLwwString(index: number): LwwValue<string> {
        return this.subblock(index, () => {
            const timestamp = this.readId(1)
            return lww(timestamp, this.readString(2))
        })
    }

    readLwwBytes(index: number): LwwValue<Uint8Array> {
        return this.subblock(index, () => {
            const timestamp = this.readId(1)
            return lww(timestamp, this.readBytesSubblock(2))
        })
    }

    /** Raw bytes filling an entire subblock (no length prefix — image flags). */
    readBytesSubblock(index: number): Uint8Array {
        return this.subblock(index, () => this.data.readBytes(this.subblockBytesRemaining()))
    }

    readString(index: number): string {
        return this.subblock(index, () => {
            const length = this.data.readVaruint()
            const isAscii = this.data.readBool()
            if (!isAscii) throw new Error('expected is_ascii flag')
            return new TextDecoder('utf-8').decode(this.data.readBytes(length))
        })
    }

    /** String subblock optionally followed by an int format code. */
    readStringWithFormat(index: number): [string, number | null] {
        this.beginSubblock(index)
        const length = this.data.readVaruint()
        const isAscii = this.data.readBool()
        if (!isAscii) throw new Error('expected is_ascii flag')
        const str = new TextDecoder('utf-8').decode(this.data.readBytes(length))
        let fmt: number | null = null
        if (this.data.checkTag(2, TagType.Byte4)) fmt = this.readInt(2)
        const extra = this.endSubblock()
        if (extra.length > 0) throw new BlockOverflowError('string subblock leftover')
        return [str, fmt]
    }

    readIntPair(index: number): [number, number] {
        return this.subblock(index, () => [this.data.readUint32(), this.data.readUint32()])
    }
}

export class TaggedBlockWriter {
    data: DataStream

    constructor() {
        this.data = new DataStream()
    }

    getBytes(): Uint8Array {
        return this.data.getBytes()
    }

    writeHeader(): void {
        this.data.writeHeader()
    }

    private captureBody(fn: () => void): Uint8Array {
        const outer = this.data
        const body = new DataStream()
        this.data = body
        try {
            fn()
            return body.getBytes()
        } finally {
            this.data = outer
        }
    }

    /** Write a block; body is produced by `fn`. */
    block(blockType: number, minVersion: number, currentVersion: number, fn: () => void): void {
        const bytes = this.captureBody(fn)
        this.data.writeUint32(bytes.length)
        this.data.writeUint8(0)
        this.data.writeUint8(minVersion)
        this.data.writeUint8(currentVersion)
        this.data.writeUint8(blockType)
        this.data.writeBytes(bytes)
    }

    /** Write a subblock; body is produced by `fn`. */
    subblock(index: number, fn: () => void): void {
        const bytes = this.captureBody(fn)
        this.data.writeTag(index, TagType.Length4)
        this.data.writeUint32(bytes.length)
        this.data.writeBytes(bytes)
    }

    writeId(index: number, value: CrdtId): void {
        this.data.writeTag(index, TagType.ID)
        this.data.writeCrdtId(value)
    }

    writeBool(index: number, value: boolean): void {
        this.data.writeTag(index, TagType.Byte1)
        this.data.writeBool(value)
    }

    writeByte(index: number, value: number): void {
        this.data.writeTag(index, TagType.Byte1)
        this.data.writeUint8(value)
    }

    writeInt(index: number, value: number): void {
        this.data.writeTag(index, TagType.Byte4)
        this.data.writeUint32(value)
    }

    writeFloat(index: number, value: number): void {
        this.data.writeTag(index, TagType.Byte4)
        this.data.writeFloat32(value)
    }

    writeDouble(index: number, value: number): void {
        this.data.writeTag(index, TagType.Byte8)
        this.data.writeFloat64(value)
    }

    writeLwwBool(index: number, value: LwwValue<boolean>): void {
        this.subblock(index, () => {
            this.writeId(1, value.timestamp)
            this.writeBool(2, value.value)
        })
    }

    writeLwwByte(index: number, value: LwwValue<number>): void {
        this.subblock(index, () => {
            this.writeId(1, value.timestamp)
            this.writeByte(2, value.value)
        })
    }

    writeLwwFloat(index: number, value: LwwValue<number>): void {
        this.subblock(index, () => {
            this.writeId(1, value.timestamp)
            this.writeFloat(2, value.value)
        })
    }

    writeLwwId(index: number, value: LwwValue<CrdtId>): void {
        this.subblock(index, () => {
            this.writeId(1, value.timestamp)
            this.writeId(2, value.value)
        })
    }

    writeLwwString(index: number, value: LwwValue<string>): void {
        this.subblock(index, () => {
            this.writeId(1, value.timestamp)
            this.writeString(2, value.value)
        })
    }

    writeLwwBytes(index: number, value: LwwValue<Uint8Array>): void {
        this.subblock(index, () => {
            this.writeId(1, value.timestamp)
            this.writeBytesSubblock(2, value.value)
        })
    }

    /** Raw bytes as an entire subblock (no length prefix — image flags). */
    writeBytesSubblock(index: number, value: Uint8Array): void {
        this.subblock(index, () => this.data.writeBytes(value))
    }

    writeString(index: number, value: string): void {
        this.subblock(index, () => {
            const bytes = new TextEncoder().encode(value)
            this.data.writeVaruint(bytes.length)
            this.data.writeBool(true)
            this.data.writeBytes(bytes)
        })
    }

    writeStringWithFormat(index: number, text: string, fmt: number | null): void {
        this.subblock(index, () => {
            const bytes = new TextEncoder().encode(text)
            this.data.writeVaruint(bytes.length)
            this.data.writeBool(true)
            this.data.writeBytes(bytes)
            if (fmt !== null) this.writeInt(2, fmt)
        })
    }

    writeIntPair(index: number, value: [number, number]): void {
        this.subblock(index, () => {
            this.data.writeUint32(value[0])
            this.data.writeUint32(value[1])
        })
    }
}
