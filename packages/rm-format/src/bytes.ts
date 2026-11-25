/**
 * Binary stream primitives for the v6 tagged-block format.
 * Little-endian throughout. Pure, no I/O.
 */

import { type CrdtId, crdtId } from './crdt-id'

export const HEADER_V6 = new TextEncoder().encode(
    'reMarkable .lines file, version=6          ',
)

/** Wire tag types: low nibble of the tag varuint. */
export enum TagType {
    ID = 0xf,
    Length4 = 0xc,
    Byte8 = 0x8,
    Byte4 = 0x4,
    Byte2 = 0x2,
    Byte1 = 0x1,
}

export class UnexpectedTagError extends Error {
    override name = 'UnexpectedTagError'
}
export class EofError extends Error {
    override name = 'EofError'
    constructor() {
        super('EOF')
    }
}

export class DataStream {
    private buffer: ArrayBuffer
    private view: DataView
    private pos = 0
    /** Logical end for reading / current extent for writing. */
    private length: number

    constructor(data?: ArrayBuffer | Uint8Array) {
        if (data instanceof Uint8Array) {
            this.buffer = new ArrayBuffer(data.byteLength)
            new Uint8Array(this.buffer).set(data)
            this.length = data.byteLength
        } else if (data) {
            this.buffer = data
            this.length = data.byteLength
        } else {
            this.buffer = new ArrayBuffer(1024)
            this.length = 0
        }
        this.view = new DataView(this.buffer)
    }

    tell(): number {
        return this.pos
    }

    seek(position: number): void {
        if (position < 0 || position > this.length) {
            throw new Error(`seek ${position} out of bounds [0, ${this.length}]`)
        }
        this.pos = position
    }

    remaining(): number {
        return this.length - this.pos
    }

    /** All bytes written so far (copy-free view; do not mutate). */
    getBytes(): Uint8Array {
        return new Uint8Array(this.buffer, 0, this.length)
    }

    private need(n: number): void {
        if (this.pos + n > this.length) throw new EofError()
    }

    private grow(n: number): void {
        const needed = this.pos + n
        if (needed > this.buffer.byteLength) {
            let size = this.buffer.byteLength || 1024
            while (size < needed) size *= 2
            const next = new ArrayBuffer(size)
            new Uint8Array(next).set(new Uint8Array(this.buffer, 0, this.length))
            this.buffer = next
            this.view = new DataView(this.buffer)
        }
        if (needed > this.length) this.length = needed
    }

    // --- reads ---

    readBytes(n: number): Uint8Array {
        this.need(n)
        const out = new Uint8Array(this.buffer.slice(this.pos, this.pos + n))
        this.pos += n
        return out
    }

    readUint8(): number {
        this.need(1)
        return this.view.getUint8(this.pos++)
    }

    readBool(): boolean {
        return this.readUint8() !== 0
    }

    readUint16(): number {
        this.need(2)
        const v = this.view.getUint16(this.pos, true)
        this.pos += 2
        return v
    }

    readUint32(): number {
        this.need(4)
        const v = this.view.getUint32(this.pos, true)
        this.pos += 4
        return v
    }

    readFloat32(): number {
        this.need(4)
        const v = this.view.getFloat32(this.pos, true)
        this.pos += 4
        return v
    }

    readFloat64(): number {
        this.need(8)
        const v = this.view.getFloat64(this.pos, true)
        this.pos += 8
        return v
    }

    readVaruint(): number {
        let shift = 0
        let result = 0
        for (;;) {
            const byte = this.readUint8()
            // Beyond 32 bits, JS bitwise ops break; use multiplication.
            result += (byte & 0x7f) * 2 ** shift
            if (!(byte & 0x80)) return result
            shift += 7
            if (shift > 56) throw new Error('varuint too long')
        }
    }

    readCrdtId(): CrdtId {
        const part1 = this.readUint8()
        const part2 = this.readVaruint()
        return crdtId(part1, part2)
    }

    readHeader(): void {
        const header = this.readBytes(HEADER_V6.length)
        for (let i = 0; i < HEADER_V6.length; i++) {
            if (header[i] !== HEADER_V6[i]) throw new Error(`bad v6 header at byte ${i}`)
        }
    }

    /** Read tag; throws UnexpectedTagError (position restored) on mismatch. */
    readTag(expectedIndex: number, expectedType: TagType): void {
        const start = this.pos
        const x = this.readVaruint()
        const index = x >> 4
        const type = x & 0xf
        if (index !== expectedIndex || type !== expectedType) {
            this.pos = start
            throw new UnexpectedTagError(
                `expected tag ${expectedIndex}:0x${expectedType.toString(16)}, got ${index}:0x${type.toString(16)} at ${start}`,
            )
        }
    }

    /** Peek whether the next tag matches, without advancing. */
    checkTag(expectedIndex: number, expectedType: TagType): boolean {
        const start = this.pos
        try {
            const x = this.readVaruint()
            return x >> 4 === expectedIndex && (x & 0xf) === expectedType
        } catch {
            return false
        } finally {
            this.pos = start
        }
    }

    // --- writes ---

    writeBytes(bytes: Uint8Array): void {
        this.grow(bytes.length)
        new Uint8Array(this.buffer, this.pos, bytes.length).set(bytes)
        this.pos += bytes.length
    }

    writeUint8(v: number): void {
        this.grow(1)
        this.view.setUint8(this.pos++, v)
    }

    writeBool(v: boolean): void {
        this.writeUint8(v ? 1 : 0)
    }

    writeUint16(v: number): void {
        this.grow(2)
        this.view.setUint16(this.pos, v, true)
        this.pos += 2
    }

    writeUint32(v: number): void {
        this.grow(4)
        this.view.setUint32(this.pos, v, true)
        this.pos += 4
    }

    writeFloat32(v: number): void {
        this.grow(4)
        this.view.setFloat32(this.pos, v, true)
        this.pos += 4
    }

    writeFloat64(v: number): void {
        this.grow(8)
        this.view.setFloat64(this.pos, v, true)
        this.pos += 8
    }

    writeVaruint(value: number): void {
        if (value < 0) throw new Error('varuint must be non-negative')
        for (;;) {
            const low = value % 128
            value = Math.floor(value / 128)
            if (value > 0) this.writeUint8(low | 0x80)
            else {
                this.writeUint8(low)
                return
            }
        }
    }

    writeCrdtId(id: CrdtId): void {
        if (id.part1 > 0xff || id.part1 < 0) throw new Error(`author index out of range: ${id.part1}`)
        this.writeUint8(id.part1)
        this.writeVaruint(id.part2)
    }

    writeHeader(): void {
        this.writeBytes(HEADER_V6)
    }

    writeTag(index: number, type: TagType): void {
        this.writeVaruint((index << 4) | type)
    }
}
