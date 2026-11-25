/**
 * Block model + readers + writers for the .rm v6 format.
 *
 * Round-trip guarantee: every block either parses fully (writer reproduces it
 * byte-exact) or is preserved as a RawBlock (verbatim bytes), so
 * `writeBlocks(readBlocks(f))` never corrupts a file, including unknown
 * fields from newer firmware.
 *
 * Parsed blocks retain their wire `version` and any `extraData` trailing
 * bytes; scene item blocks additionally retain `extraValueData` (trailing
 * bytes inside the value subblock).
 */

import { type CrdtId, type LwwValue, crdtId, crdtIdKey } from './crdt-id'
import { TagType } from './bytes'
import { TaggedBlockReader, TaggedBlockWriter } from './tagged-block'
import { type CrdtSequenceItem, CrdtSequence } from './crdt-sequence'
import {
    type Line,
    type Text,
    type GlyphRange,
    type Image,
    type Point,
    type Rectangle,
    type ParagraphStyle,
    type PenColor,
    type Pen,
} from './scene-items'

export const BlockType = {
    MigrationInfo: 0x00,
    SceneTree: 0x01,
    TreeNode: 0x02,
    SceneGlyphItem: 0x03,
    SceneGroupItem: 0x04,
    SceneLineItem: 0x05,
    SceneTextItem: 0x06,
    RootText: 0x07,
    SceneTombstoneItem: 0x08,
    AuthorIds: 0x09,
    PageInfo: 0x0a,
    SceneInfo: 0x0d,
    SceneImageInfo: 0x0e,
    SceneImageItem: 0x0f,
} as const

export interface BlockVersion {
    min: number
    current: number
}

interface BlockBase {
    version: BlockVersion
    /** Unparsed trailing bytes at block level (round-tripped verbatim). */
    extraData: Uint8Array
}

const EMPTY: Uint8Array = new Uint8Array(0)

export interface AuthorIdsBlock extends BlockBase {
    type: 'authorIds'
    /** author index (file-local) -> uuid string */
    authors: Map<number, string>
}

export interface MigrationInfoBlock extends BlockBase {
    type: 'migrationInfo'
    migrationId: CrdtId
    isDevice: boolean
    /** Optional third bool on newer firmware; null = absent on the wire. */
    unknown: boolean | null
}

export interface PageInfoBlock extends BlockBase {
    type: 'pageInfo'
    loadsCount: number
    mergesCount: number
    textCharsCount: number
    textLinesCount: number
    /** null = absent on the wire. */
    typeFolioUseCount: number | null
}

export interface SceneTreeBlock extends BlockBase {
    type: 'sceneTree'
    treeId: CrdtId
    nodeId: CrdtId
    isUpdate: boolean
    parentId: CrdtId
}

export interface TreeNodeBlock extends BlockBase {
    type: 'treeNode'
    nodeId: CrdtId
    label: LwwValue<string>
    visible: LwwValue<boolean>
    anchorId: LwwValue<CrdtId> | null
    anchorType: LwwValue<number> | null
    anchorThreshold: LwwValue<number> | null
    anchorOriginX: LwwValue<number> | null
}

export interface SceneInfoBlock extends BlockBase {
    type: 'sceneInfo'
    currentLayer: LwwValue<CrdtId>
    backgroundVisible: LwwValue<boolean> | null
    rootDocumentVisible: LwwValue<boolean> | null
    paperSize: [number, number] | null
}

export interface SceneItemBlockBase extends BlockBase {
    parentId: CrdtId
    itemId: CrdtId
    leftId: CrdtId
    rightId: CrdtId
    deletedLength: number
    /** Unparsed trailing bytes inside the value subblock. */
    extraValueData: Uint8Array
}

export interface SceneLineItemBlock extends SceneItemBlockBase {
    type: 'sceneLineItem'
    /** null = tombstoned item with no value subblock. */
    line: Line | null
}

export interface SceneGroupItemBlock extends SceneItemBlockBase {
    type: 'sceneGroupItem'
    nodeId: CrdtId | null
}

export interface SceneGlyphItemBlock extends SceneItemBlockBase {
    type: 'sceneGlyphItem'
    glyph: GlyphRange | null
}

export interface SceneTombstoneItemBlock extends SceneItemBlockBase {
    type: 'sceneTombstoneItem'
}

/** One asset registered in a SceneImageInfo block (firmware 3.27+). */
export interface ImageInfoEntry {
    /** Canonical uuid string; pixel bytes live in `<filename>` in the doc dir. */
    uuid: string
    filename: LwwValue<string>
    /** Opaque flag bytes; observed [17, 0]. */
    flags: LwwValue<Uint8Array>
}

/** Top-level image asset registry (block 0x0E): uuid -> filename. */
export interface SceneImageInfoBlock extends BlockBase {
    type: 'sceneImageInfo'
    /** Order preserved for byte-exact round-trips. */
    images: ImageInfoEntry[]
}

/** Image placement in the scene tree (block 0x0F, item type 7). */
export interface SceneImageItemBlock extends SceneItemBlockBase {
    type: 'sceneImageItem'
    /** null = tombstoned item with no value subblock. */
    image: Image | null
}

export interface RootTextBlock extends BlockBase {
    type: 'rootText'
    blockId: CrdtId
    text: Text
    textItems: TextItem[]
    /** The original width fallback and optional timestamped width extension. */
    widthData?: {
        legacy: number
        register?: LwwValue<number> & {
            extraData: Uint8Array
            timestampMissing?: true
            valueMissing?: true
        }
        extraData: Uint8Array
    }
}

export function effectiveRootTextWidth(legacyWidth: number, registeredWidth = 0): number {
    if (registeredWidth > 0) return registeredWidth
    return legacyWidth > 0 ? legacyWidth : 0
}

export interface TextItem {
    itemId: CrdtId
    leftId: CrdtId
    rightId: CrdtId
    deletedLength: number
    /** string fragment | format code | null (no value subblock on wire). */
    value: string | number | null
}

/** Any block we could not fully parse: preserved verbatim. */
export interface RawBlock extends BlockBase {
    type: 'raw'
    blockType: number
    data: Uint8Array
    parseError: string | null
}

export type RmBlock =
    | AuthorIdsBlock
    | MigrationInfoBlock
    | PageInfoBlock
    | SceneTreeBlock
    | TreeNodeBlock
    | SceneInfoBlock
    | SceneLineItemBlock
    | SceneGroupItemBlock
    | SceneGlyphItemBlock
    | SceneTombstoneItemBlock
    | SceneImageInfoBlock
    | SceneImageItemBlock
    | RootTextBlock
    | RawBlock

// ============================================================
// Reading
// ============================================================

export function* readBlocks(data: ArrayBuffer | Uint8Array): Generator<RmBlock> {
    const reader = new TaggedBlockReader(data)
    reader.readHeader()
    for (;;) {
        const header = reader.readBlockHeader()
        if (!header) return
        const version: BlockVersion = { min: header.minVersion, current: header.currentVersion }
        let block: RmBlock
        try {
            block = readBlockBody(reader, header.blockType, version)
            block.extraData = reader.endBlock()
        } catch (e) {
            reader.data.seek(header.offset)
            const raw = reader.readRawBlockBody()
            reader.endBlock()
            block = {
                type: 'raw',
                blockType: header.blockType,
                version,
                extraData: EMPTY,
                data: raw,
                parseError: String(e),
            }
        }
        yield block
    }
}

function readBlockBody(reader: TaggedBlockReader, blockType: number, version: BlockVersion): RmBlock {
    switch (blockType) {
        case BlockType.AuthorIds:
            return readAuthorIds(reader, version)
        case BlockType.MigrationInfo:
            return readMigrationInfo(reader, version)
        case BlockType.PageInfo:
            return readPageInfo(reader, version)
        case BlockType.SceneTree:
            return readSceneTree(reader, version)
        case BlockType.TreeNode:
            return readTreeNode(reader, version)
        case BlockType.SceneInfo:
            return readSceneInfo(reader, version)
        case BlockType.SceneLineItem:
            return readSceneLineItem(reader, version)
        case BlockType.SceneGroupItem:
            return readSceneGroupItem(reader, version)
        case BlockType.SceneGlyphItem:
            return readSceneGlyphItem(reader, version)
        case BlockType.SceneTombstoneItem:
        case BlockType.SceneTextItem:
            return readTombstoneLike(reader, version, blockType)
        case BlockType.RootText:
            return readRootText(reader, version)
        case BlockType.SceneImageInfo:
            return readSceneImageInfo(reader, version)
        case BlockType.SceneImageItem:
            return readSceneImageItem(reader, version)
        default:
            throw new Error(`unknown block type ${blockType}`)
    }
}

function readSceneImageInfo(reader: TaggedBlockReader, version: BlockVersion): SceneImageInfoBlock {
    const images: ImageInfoEntry[] = []
    reader.beginSubblock(1)
    const count = reader.data.readVaruint()
    for (let i = 0; i < count; i++) {
        reader.beginSubblock(0)
        const uuid = bytesToUuidLE(reader.data.readBytes(16))
        const filename = reader.readLwwString(1)
        const flags = reader.readLwwBytes(2)
        const extra = reader.endSubblock()
        if (extra.length > 0) throw new Error(`imageInfo entry leftover ${extra.length}B`)
        images.push({ uuid, filename, flags })
    }
    const extra = reader.endSubblock()
    if (extra.length > 0) throw new Error(`imageInfo leftover ${extra.length}B`)
    return { type: 'sceneImageInfo', version, extraData: EMPTY, images }
}

function readSceneImageItem(reader: TaggedBlockReader, version: BlockVersion): SceneImageItemBlock {
    const common = readItemCommon(reader)
    let image: Image | null = null
    let extraValueData = EMPTY

    if (reader.hasSubblock(6)) {
        reader.beginSubblock(6)
        const itemType = reader.data.readUint8()
        if (itemType !== 7) throw new Error(`expected image item type 7, got ${itemType}`)
        const uuid = reader.readLwwBytes(1)
        const timestamp = reader.readId(2)

        const vertices: number[] = []
        reader.beginSubblock(3)
        const vertexCount = reader.data.readVaruint()
        for (let i = 0; i < vertexCount; i++) vertices.push(reader.data.readFloat32())
        const vExtra = reader.endSubblock()
        if (vExtra.length > 0) throw new Error(`image vertices leftover ${vExtra.length}B`)

        // quad triangulation indices (observed [0,1,2,2,3,0]); round-tripped
        // as read rather than asserted, so future variants stay parseable
        const indices: number[] = []
        reader.beginSubblock(4)
        const indexCount = reader.data.readVaruint()
        for (let i = 0; i < indexCount; i++) indices.push(reader.data.readUint32())
        const iExtra = reader.endSubblock()
        if (iExtra.length > 0) throw new Error(`image indices leftover ${iExtra.length}B`)

        extraValueData = reader.endSubblock()
        image = { kind: 'image', uuid, timestamp, vertices, indices, filename: null }
    }

    return { type: 'sceneImageItem', version, extraData: EMPTY, ...common, image, extraValueData }
}

export function bytesToUuidLE(bytes: Uint8Array): string {
    const h = (i: number) => bytes[i]!.toString(16).padStart(2, '0')
    return [
        h(3) + h(2) + h(1) + h(0),
        h(5) + h(4),
        h(7) + h(6),
        h(8) + h(9),
        h(10) + h(11) + h(12) + h(13) + h(14) + h(15),
    ].join('-')
}

export function uuidToBytesLE(uuid: string): Uint8Array {
    const hex = uuid.replace(/-/g, '')
    if (hex.length !== 32) throw new Error(`bad uuid: ${uuid}`)
    const b = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    // Inverse of bytesToUuidLE: first three groups little-endian.
    return new Uint8Array([
        b(3), b(2), b(1), b(0),
        b(5), b(4),
        b(7), b(6),
        b(8), b(9),
        b(10), b(11), b(12), b(13), b(14), b(15),
    ])
}

function readAuthorIds(reader: TaggedBlockReader, version: BlockVersion): AuthorIdsBlock {
    const count = reader.data.readVaruint()
    const authors = new Map<number, string>()
    for (let i = 0; i < count; i++) {
        reader.beginSubblock(0)
        const uuidLength = reader.data.readVaruint()
        const uuidBytes = reader.data.readBytes(uuidLength)
        const authorIndex = reader.data.readUint16()
        const extra = reader.endSubblock()
        if (extra.length > 0) throw new Error('authorIds subblock leftover')
        authors.set(authorIndex, bytesToUuidLE(uuidBytes))
    }
    return { type: 'authorIds', version, extraData: EMPTY, authors }
}

function readMigrationInfo(reader: TaggedBlockReader, version: BlockVersion): MigrationInfoBlock {
    const migrationId = reader.readId(1)
    const isDevice = reader.readBool(2)
    const unknown = reader.bytesRemainingInBlock() > 0 ? reader.readBoolOptional(3) : null
    return { type: 'migrationInfo', version, extraData: EMPTY, migrationId, isDevice, unknown }
}

function readPageInfo(reader: TaggedBlockReader, version: BlockVersion): PageInfoBlock {
    const loadsCount = reader.readInt(1)
    const mergesCount = reader.readInt(2)
    const textCharsCount = reader.readInt(3)
    const textLinesCount = reader.readInt(4)
    const typeFolioUseCount = reader.bytesRemainingInBlock() > 0 ? reader.readIntOptional(5) : null
    return {
        type: 'pageInfo', version, extraData: EMPTY,
        loadsCount, mergesCount, textCharsCount, textLinesCount, typeFolioUseCount,
    }
}

function readSceneTree(reader: TaggedBlockReader, version: BlockVersion): SceneTreeBlock {
    const treeId = reader.readId(1)
    const nodeId = reader.readId(2)
    const isUpdate = reader.readBool(3)
    const parentId = reader.subblock(4, () => reader.readId(1))
    return { type: 'sceneTree', version, extraData: EMPTY, treeId, nodeId, isUpdate, parentId }
}

function readTreeNode(reader: TaggedBlockReader, version: BlockVersion): TreeNodeBlock {
    const nodeId = reader.readId(1)
    const label = reader.readLwwString(2)
    const visible = reader.readLwwBool(3)
    let anchorId: LwwValue<CrdtId> | null = null
    let anchorType: LwwValue<number> | null = null
    let anchorThreshold: LwwValue<number> | null = null
    let anchorOriginX: LwwValue<number> | null = null
    if (reader.bytesRemainingInBlock() > 0) {
        anchorId = reader.readLwwId(7)
        anchorType = reader.readLwwByte(8)
        anchorThreshold = reader.readLwwFloat(9)
        anchorOriginX = reader.readLwwFloat(10)
    }
    return {
        type: 'treeNode', version, extraData: EMPTY,
        nodeId, label, visible, anchorId, anchorType, anchorThreshold, anchorOriginX,
    }
}

function readSceneInfo(reader: TaggedBlockReader, version: BlockVersion): SceneInfoBlock {
    const currentLayer = reader.readLwwId(1)
    const backgroundVisible = reader.bytesRemainingInBlock() > 0 ? reader.readLwwBool(2) : null
    const rootDocumentVisible = reader.bytesRemainingInBlock() > 0 ? reader.readLwwBool(3) : null
    const paperSize = reader.bytesRemainingInBlock() > 0 && reader.hasSubblock(5)
        ? reader.readIntPair(5)
        : null
    // Unknown tag-6 subblock on some firmware lands in block extraData.
    return {
        type: 'sceneInfo', version, extraData: EMPTY,
        currentLayer, backgroundVisible, rootDocumentVisible, paperSize,
    }
}

interface ItemCommon {
    parentId: CrdtId
    itemId: CrdtId
    leftId: CrdtId
    rightId: CrdtId
    deletedLength: number
}

function readItemCommon(reader: TaggedBlockReader): ItemCommon {
    const parentId = reader.readId(1)
    const itemId = reader.readId(2)
    const leftId = reader.readId(3)
    const rightId = reader.readId(4)
    const deletedLength = reader.readInt(5)
    return { parentId, itemId, leftId, rightId, deletedLength }
}

function pointSize(version: number): number {
    return version === 1 ? 0x18 : 0x0e
}

function readPoint(reader: TaggedBlockReader, version: number): Point {
    const x = reader.data.readFloat32()
    const y = reader.data.readFloat32()
    if (version === 1) {
        const speed = reader.data.readFloat32() * 4
        const direction = (255 * reader.data.readFloat32()) / (Math.PI * 2)
        const width = reader.data.readFloat32() * 4
        const pressure = reader.data.readFloat32() * 255
        return { x, y, speed, direction, width, pressure }
    }
    const speed = reader.data.readUint16()
    const width = reader.data.readUint16()
    const direction = reader.data.readUint8()
    const pressure = reader.data.readUint8()
    return { x, y, speed, direction, width, pressure }
}

function writePoint(writer: TaggedBlockWriter, point: Point, version: number): void {
    writer.data.writeFloat32(point.x)
    writer.data.writeFloat32(point.y)
    if (version === 1) {
        writer.data.writeFloat32(point.speed / 4)
        writer.data.writeFloat32((point.direction * (Math.PI * 2)) / 255)
        writer.data.writeFloat32(point.width / 4)
        writer.data.writeFloat32(point.pressure / 255)
    } else {
        writer.data.writeUint16(point.speed)
        writer.data.writeUint16(point.width)
        writer.data.writeUint8(point.direction)
        writer.data.writeUint8(point.pressure)
    }
}

function readSceneLineItem(reader: TaggedBlockReader, version: BlockVersion): SceneLineItemBlock {
    const common = readItemCommon(reader)
    let line: Line | null = null
    let extraValueData = EMPTY

    if (reader.hasSubblock(6)) {
        reader.beginSubblock(6)
        const itemType = reader.data.readUint8()
        if (itemType !== 3) throw new Error(`expected line item type 3, got ${itemType}`)
        const tool = reader.readInt(1) as Pen
        const color = reader.readInt(2) as PenColor
        const thicknessScale = reader.readDouble(3)
        const startingLength = reader.readFloat(4)

        reader.beginSubblock(5)
        const points: Point[] = []
        // Points fill the whole subblock; a non-multiple size is a parse error
        // (falls back to RawBlock, preserving bytes verbatim).
        const size = pointSize(version.current)
        while (reader.subblockBytesRemaining() >= size) {
            points.push(readPoint(reader, version.current))
        }
        const pointsExtra = reader.endSubblock()
        if (pointsExtra.length > 0) throw new Error(`points subblock leftover ${pointsExtra.length}B`)

        const timestamp = reader.readId(6)
        let moveId: CrdtId | null = null
        if (reader.subblockBytesRemaining() >= 3) {
            moveId = reader.readIdOptional(7)
        }
        extraValueData = reader.endSubblock()
        line = { kind: 'line', tool, color, thicknessScale, startingLength, points, timestamp, moveId }
    }

    return { type: 'sceneLineItem', version, extraData: EMPTY, ...common, line, extraValueData }
}

function readSceneGroupItem(reader: TaggedBlockReader, version: BlockVersion): SceneGroupItemBlock {
    const common = readItemCommon(reader)
    let nodeId: CrdtId | null = null
    let extraValueData = EMPTY
    if (reader.hasSubblock(6)) {
        reader.beginSubblock(6)
        const itemType = reader.data.readUint8()
        if (itemType !== 2) throw new Error(`expected group item type 2, got ${itemType}`)
        nodeId = reader.readId(2)
        extraValueData = reader.endSubblock()
    }
    return { type: 'sceneGroupItem', version, extraData: EMPTY, ...common, nodeId, extraValueData }
}

function readSceneGlyphItem(reader: TaggedBlockReader, version: BlockVersion): SceneGlyphItemBlock {
    const common = readItemCommon(reader)
    let glyph: GlyphRange | null = null
    let extraValueData = EMPTY
    if (reader.hasSubblock(6)) {
        reader.beginSubblock(6)
        const itemType = reader.data.readUint8()
        if (itemType !== 1) throw new Error(`expected glyph item type 1, got ${itemType}`)
        const start = reader.readIntOptional(2)
        const length = reader.readIntOptional(3) ?? 0
        const color = reader.readInt(4) as PenColor
        const text = reader.readString(5)
        const rectangles = reader.subblock(6, () => {
            const n = reader.data.readVaruint()
            const rects: Rectangle[] = []
            for (let i = 0; i < n; i++) {
                rects.push({
                    x: reader.data.readFloat64(),
                    y: reader.data.readFloat64(),
                    w: reader.data.readFloat64(),
                    h: reader.data.readFloat64(),
                })
            }
            return rects
        })
        extraValueData = reader.endSubblock()
        glyph = { kind: 'glyphRange', start, length: length || text.length, text, color, rectangles }
    }
    return { type: 'sceneGlyphItem', version, extraData: EMPTY, ...common, glyph, extraValueData }
}

function readTombstoneLike(
    reader: TaggedBlockReader,
    version: BlockVersion,
    blockType: number,
): SceneTombstoneItemBlock {
    const common = readItemCommon(reader)
    let extraValueData = EMPTY
    if (reader.hasSubblock(6)) {
        reader.beginSubblock(6)
        // This value is opaque: preserve its discriminator along with the
        // payload. Empty values retain the existing raw-block fallback.
        if (reader.subblockBytesRemaining() === 0) throw new Error('empty scene item value')
        extraValueData = reader.endSubblock()
    }
    if (blockType === BlockType.SceneTextItem) {
        // Model SceneTextItem as a tombstone-like block, but tag its wire
        // type so the writer re-serializes it as SceneTextItem, not tombstone.
        return {
            type: 'sceneTombstoneItem', version, extraData: EMPTY, ...common, extraValueData,
            ...( { __wireType: blockType } as object ),
        } as SceneTombstoneItemBlock
    }
    return { type: 'sceneTombstoneItem', version, extraData: EMPTY, ...common, extraValueData }
}

function readRootText(reader: TaggedBlockReader, version: BlockVersion): RootTextBlock {
    const blockId = reader.readId(1)

    const textItems: TextItem[] = []
    const styles = new Map<string, LwwValue<ParagraphStyle>>()

    reader.beginSubblock(2)
    reader.beginSubblock(1)
    reader.beginSubblock(1)
    const numItems = reader.data.readVaruint()
    for (let i = 0; i < numItems; i++) {
        reader.beginSubblock(0)
        const itemId = reader.readId(2)
        const leftId = reader.readId(3)
        const rightId = reader.readId(4)
        const deletedLength = reader.readInt(5)
        let value: string | number | null = null
        if (reader.hasSubblock(6)) {
            const [text, fmt] = reader.readStringWithFormat(6)
            value = fmt !== null ? fmt : text
        }
        const itemExtra = reader.endSubblock()
        if (itemExtra.length > 0) throw new Error('text item leftover')
        textItems.push({ itemId, leftId, rightId, deletedLength, value })
    }
    assertEmpty(reader.endSubblock(), 'rootText 2.1.1')
    assertEmpty(reader.endSubblock(), 'rootText 2.1')

    reader.beginSubblock(2)
    reader.beginSubblock(1)
    const numFormats = reader.data.readVaruint()
    for (let i = 0; i < numFormats; i++) {
        const charId = reader.data.readCrdtId()
        const timestamp = reader.readId(1)
        // style subblock: marker byte 17 + style value, then OPTIONAL extra
        // tagged fields (newer firmware appends text-size fields: Byte1@2 +
        // Byte4@3). Preserve them verbatim.
        reader.beginSubblock(2)
        const marker = reader.data.readUint8()
        if (marker !== 17) throw new Error(`format marker ${marker} != 17`)
        const code = reader.data.readUint8()
        const styleExtra = reader.endSubblock()
        styles.set(crdtIdKey(charId), {
            timestamp,
            value: code,
            ...(styleExtra.length > 0 ? { extra: styleExtra } : {}),
        })
    }
    assertEmpty(reader.endSubblock(), 'rootText 2.2.1')
    assertEmpty(reader.endSubblock(), 'rootText 2.2')
    assertEmpty(reader.endSubblock(), 'rootText 2')

    const [posX, posY] = reader.subblock(3, () => [reader.data.readFloat64(), reader.data.readFloat64()])
    const legacyWidth = reader.readFloat(4)
    let widthData: RootTextBlock['widthData']
    if (reader.hasSubblock(5)) {
        reader.beginSubblock(5)
        let register: NonNullable<RootTextBlock['widthData']>['register']
        if (reader.hasSubblock(1)) {
            reader.beginSubblock(1)
            const timestamp = reader.subblockBytesRemaining() > 0 ? reader.readIdOptional(1) : null
            const hasValue = reader.subblockBytesRemaining() > 0 && reader.data.checkTag(2, TagType.Byte4)
            register = {
                timestamp: timestamp ?? crdtId(0, 0),
                value: hasValue ? reader.readFloat(2) : 0,
                ...(timestamp === null ? { timestampMissing: true } : {}),
                ...(!hasValue ? { valueMissing: true } : {}),
                extraData: reader.endSubblock(),
            }
        }
        widthData = {
            legacy: legacyWidth,
            ...(register ? { register } : {}),
            extraData: reader.endSubblock(),
        }
    }
    const width = widthData ? effectiveRootTextWidth(legacyWidth, widthData.register?.value) : legacyWidth

    const items = new CrdtSequence<string | number>(
        textItems.map((t) => ({
            itemId: t.itemId,
            leftId: t.leftId,
            rightId: t.rightId,
            deletedLength: t.deletedLength,
            value: t.value ?? '',
        })),
    )

    return {
        type: 'rootText', version, extraData: EMPTY, blockId,
        text: { kind: 'text', items, styles, posX, posY, width },
        textItems,
        ...(widthData ? { widthData } : {}),
    }
}

function assertEmpty(extra: Uint8Array, where: string): void {
    if (extra.length > 0) throw new Error(`${where}: ${extra.length} unread bytes`)
}

// ============================================================
// Writing
// ============================================================

export function writeBlocks(blocks: Iterable<RmBlock>): Uint8Array {
    const writer = new TaggedBlockWriter()
    writer.writeHeader()
    for (const block of blocks) writeBlock(writer, block)
    return writer.getBytes()
}

export function writeBlock(writer: TaggedBlockWriter, block: RmBlock): void {
    const wireType = blockWireType(block)
    writer.block(wireType, block.version.min, block.version.current, () => {
        writeBlockBody(writer, block)
        if (block.extraData.length > 0) writer.data.writeBytes(block.extraData)
    })
}

function blockWireType(block: RmBlock): number {
    switch (block.type) {
        case 'authorIds':
            return BlockType.AuthorIds
        case 'migrationInfo':
            return BlockType.MigrationInfo
        case 'pageInfo':
            return BlockType.PageInfo
        case 'sceneTree':
            return BlockType.SceneTree
        case 'treeNode':
            return BlockType.TreeNode
        case 'sceneInfo':
            return BlockType.SceneInfo
        case 'sceneLineItem':
            return BlockType.SceneLineItem
        case 'sceneGroupItem':
            return BlockType.SceneGroupItem
        case 'sceneGlyphItem':
            return BlockType.SceneGlyphItem
        case 'sceneTombstoneItem':
            return (block as unknown as { __wireType?: number }).__wireType ?? BlockType.SceneTombstoneItem
        case 'rootText':
            return BlockType.RootText
        case 'sceneImageInfo':
            return BlockType.SceneImageInfo
        case 'sceneImageItem':
            return BlockType.SceneImageItem
        case 'raw':
            return block.blockType
    }
}

function writeBlockBody(writer: TaggedBlockWriter, block: RmBlock): void {
    switch (block.type) {
        case 'raw':
            writer.data.writeBytes(block.data)
            return
        case 'authorIds': {
            writer.data.writeVaruint(block.authors.size)
            for (const [index, uuid] of block.authors) {
                writer.subblock(0, () => {
                    const bytes = uuidToBytesLE(uuid)
                    writer.data.writeVaruint(bytes.length)
                    writer.data.writeBytes(bytes)
                    writer.data.writeUint16(index)
                })
            }
            return
        }
        case 'migrationInfo': {
            writer.writeId(1, block.migrationId)
            writer.writeBool(2, block.isDevice)
            if (block.unknown !== null) writer.writeBool(3, block.unknown)
            return
        }
        case 'pageInfo': {
            writer.writeInt(1, block.loadsCount)
            writer.writeInt(2, block.mergesCount)
            writer.writeInt(3, block.textCharsCount)
            writer.writeInt(4, block.textLinesCount)
            if (block.typeFolioUseCount !== null) writer.writeInt(5, block.typeFolioUseCount)
            return
        }
        case 'sceneTree': {
            writer.writeId(1, block.treeId)
            writer.writeId(2, block.nodeId)
            writer.writeBool(3, block.isUpdate)
            writer.subblock(4, () => writer.writeId(1, block.parentId))
            return
        }
        case 'treeNode': {
            writer.writeId(1, block.nodeId)
            writer.writeLwwString(2, block.label)
            writer.writeLwwBool(3, block.visible)
            if (block.anchorId) {
                writer.writeLwwId(7, block.anchorId)
                writer.writeLwwByte(8, block.anchorType!)
                writer.writeLwwFloat(9, block.anchorThreshold!)
                writer.writeLwwFloat(10, block.anchorOriginX!)
            }
            return
        }
        case 'sceneInfo': {
            writer.writeLwwId(1, block.currentLayer)
            if (block.backgroundVisible) writer.writeLwwBool(2, block.backgroundVisible)
            if (block.rootDocumentVisible) writer.writeLwwBool(3, block.rootDocumentVisible)
            if (block.paperSize) writer.writeIntPair(5, block.paperSize)
            return
        }
        case 'sceneLineItem': {
            writeItemCommon(writer, block)
            if (block.line) {
                const line = block.line
                writer.subblock(6, () => {
                    writer.data.writeUint8(3)
                    writer.writeInt(1, line.tool)
                    writer.writeInt(2, line.color)
                    writer.writeDouble(3, line.thicknessScale)
                    writer.writeFloat(4, line.startingLength)
                    writer.subblock(5, () => {
                        for (const p of line.points) writePoint(writer, p, block.version.current)
                    })
                    writer.writeId(6, line.timestamp)
                    if (line.moveId !== null) writer.writeId(7, line.moveId)
                    if (block.extraValueData.length > 0) writer.data.writeBytes(block.extraValueData)
                })
            }
            return
        }
        case 'sceneGroupItem': {
            writeItemCommon(writer, block)
            if (block.nodeId !== null) {
                const nodeId = block.nodeId
                writer.subblock(6, () => {
                    writer.data.writeUint8(2)
                    writer.writeId(2, nodeId)
                    if (block.extraValueData.length > 0) writer.data.writeBytes(block.extraValueData)
                })
            }
            return
        }
        case 'sceneGlyphItem': {
            writeItemCommon(writer, block)
            if (block.glyph !== null) {
                const glyph = block.glyph
                writer.subblock(6, () => {
                    writer.data.writeUint8(1)
                    if (glyph.start !== null) {
                        writer.writeInt(2, glyph.start)
                        writer.writeInt(3, glyph.length)
                    }
                    writer.writeInt(4, glyph.color)
                    writer.writeString(5, glyph.text)
                    writer.subblock(6, () => {
                        writer.data.writeVaruint(glyph.rectangles.length)
                        for (const r of glyph.rectangles) {
                            writer.data.writeFloat64(r.x)
                            writer.data.writeFloat64(r.y)
                            writer.data.writeFloat64(r.w)
                            writer.data.writeFloat64(r.h)
                        }
                    })
                    if (block.extraValueData.length > 0) writer.data.writeBytes(block.extraValueData)
                })
            }
            return
        }
        case 'sceneTombstoneItem': {
            writeItemCommon(writer, block)
            if (block.extraValueData.length > 0) {
                writer.subblock(6, () => {
                    writer.data.writeBytes(block.extraValueData)
                })
            }
            return
        }
        case 'sceneImageInfo': {
            writer.subblock(1, () => {
                writer.data.writeVaruint(block.images.length)
                for (const img of block.images) {
                    writer.subblock(0, () => {
                        writer.data.writeBytes(uuidToBytesLE(img.uuid))
                        writer.writeLwwString(1, img.filename)
                        writer.writeLwwBytes(2, img.flags)
                    })
                }
            })
            return
        }
        case 'sceneImageItem': {
            writeItemCommon(writer, block)
            if (block.image) {
                const image = block.image
                writer.subblock(6, () => {
                    writer.data.writeUint8(7)
                    writer.writeLwwBytes(1, image.uuid)
                    writer.writeId(2, image.timestamp)
                    writer.subblock(3, () => {
                        writer.data.writeVaruint(image.vertices.length)
                        for (const v of image.vertices) writer.data.writeFloat32(v)
                    })
                    writer.subblock(4, () => {
                        writer.data.writeVaruint(image.indices.length)
                        for (const v of image.indices) writer.data.writeUint32(v)
                    })
                    if (block.extraValueData.length > 0) writer.data.writeBytes(block.extraValueData)
                })
            }
            return
        }
        case 'rootText': {
            writer.writeId(1, block.blockId)
            writer.subblock(2, () => {
                writer.subblock(1, () => {
                    writer.subblock(1, () => {
                        writer.data.writeVaruint(block.textItems.length)
                        for (const item of block.textItems) {
                            writer.subblock(0, () => {
                                writer.writeId(2, item.itemId)
                                writer.writeId(3, item.leftId)
                                writer.writeId(4, item.rightId)
                                writer.writeInt(5, item.deletedLength)
                                if (item.value !== null) {
                                    if (typeof item.value === 'number') {
                                        writer.writeStringWithFormat(6, '', item.value)
                                    } else {
                                        writer.writeString(6, item.value)
                                    }
                                }
                            })
                        }
                    })
                })
                writer.subblock(2, () => {
                    writer.subblock(1, () => {
                        const entries = [...block.text.styles.entries()]
                        writer.data.writeVaruint(entries.length)
                        for (const [key, style] of entries) {
                            const [part1, part2] = key.split(':').map(Number)
                            writer.data.writeCrdtId(crdtId(part1!, part2!))
                            writer.writeId(1, style.timestamp)
                            writer.subblock(2, () => {
                                writer.data.writeUint8(17)
                                writer.data.writeUint8(style.value)
                                const extra = (style as { extra?: Uint8Array }).extra
                                if (extra && extra.length > 0) writer.data.writeBytes(extra)
                            })
                        }
                    })
                })
            })
            writer.subblock(3, () => {
                writer.data.writeFloat64(block.text.posX)
                writer.data.writeFloat64(block.text.posY)
            })
            const widthData = block.widthData
            const register = widthData?.register
            const registeredWidth = register?.value ?? 0
            const legacyWidth = widthData?.legacy ?? block.text.width
            const decodedWidth = widthData ? effectiveRootTextWidth(legacyWidth, registeredWidth) : legacyWidth
            const edited = !Object.is(block.text.width, decodedWidth)
            writer.writeFloat(4, edited ? block.text.width : legacyWidth)
            if (widthData) {
                writer.subblock(5, () => {
                    if (register) {
                        writer.subblock(1, () => {
                            if (!register.timestampMissing) writer.writeId(1, register.timestamp)
                            if (!register.valueMissing) {
                                writer.writeFloat(2, edited && registeredWidth > 0 ? block.text.width : register.value)
                            }
                            writer.data.writeBytes(register.extraData)
                        })
                    }
                    writer.data.writeBytes(widthData.extraData)
                })
            }
            return
        }
    }
}

function writeItemCommon(writer: TaggedBlockWriter, block: SceneItemBlockBase): void {
    writer.writeId(1, block.parentId)
    writer.writeId(2, block.itemId)
    writer.writeId(3, block.leftId)
    writer.writeId(4, block.rightId)
    writer.writeInt(5, block.deletedLength)
}

// ============================================================
// Convenience constructors / item adapters
// ============================================================

/** View a scene item block as a CRDT sequence item (for tree building). */
export function toSequenceItem<T>(
    block: SceneItemBlockBase,
    value: T,
): CrdtSequenceItem<T> {
    return {
        itemId: block.itemId,
        leftId: block.leftId,
        rightId: block.rightId,
        deletedLength: block.deletedLength,
        value,
    }
}
