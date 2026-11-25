/**
 * @weft/rm-format — reMarkable .rm v6 codec.
 *
 * Pure, isomorphic TypeScript. Round-trip safe: unknown fields and unparsable
 * blocks are preserved byte-exact (see blocks.ts).
 */

export {
    type CrdtId,
    type LwwValue,
    END_MARKER,
    crdtId,
    crdtIdEquals,
    crdtIdCompare,
    crdtIdKey,
    isEndMarker,
    lww,
    ANCHOR_TEXT_START,
    ANCHOR_TEXT_END,
} from './crdt-id'

export { DataStream, TagType, HEADER_V6, UnexpectedTagError, EofError } from './bytes'

export {
    type CrdtSequenceItem,
    CrdtSequence,
    toposortItems,
} from './crdt-sequence'

export {
    Pen,
    PenColor,
    ParagraphStyle,
    type Point,
    type Line,
    type Group,
    type Text,
    type GlyphRange,
    type Image,
    type Rectangle,
    type SceneItem,
    type TextStyleValue,
    isLine,
    isGroup,
    isText,
    isGlyphRange,
    isImage,
} from './scene-items'

export { TaggedBlockReader, TaggedBlockWriter, BlockOverflowError } from './tagged-block'

export {
    BlockType,
    type RmBlock,
    type BlockVersion,
    type AuthorIdsBlock,
    type MigrationInfoBlock,
    type PageInfoBlock,
    type SceneTreeBlock,
    type TreeNodeBlock,
    type SceneInfoBlock,
    type SceneItemBlockBase,
    type SceneLineItemBlock,
    type SceneGroupItemBlock,
    type SceneGlyphItemBlock,
    type SceneTombstoneItemBlock,
    type ImageInfoEntry,
    type SceneImageInfoBlock,
    type SceneImageItemBlock,
    type RootTextBlock,
    type TextItem,
    type RawBlock,
    readBlocks,
    writeBlocks,
    toSequenceItem,
    bytesToUuidLE,
    uuidToBytesLE,
} from './blocks'

export { SceneTree, buildTree, ROOT_ID } from './scene-tree'
export {
    linearizeRootText,
    rootTextCharPositions,
    firstParagraphStyleShadows,
    paragraphStyleShadows,
    parseStyleExtra,
    encodeStyleExtra,
    paragraphStyleWriteExtra,
    type CharPosition,
    type TextParagraph,
    type TextSpan,
} from './text-doc'
export { RmDocument } from './document'
export {
    createRootText,
    insertText,
    insertFormatCode,
    deleteText,
    setParagraphStyle,
    planFormatEdits,
    mergeRootTextInto,
    RootTextAuthorConflict,
    rootTextUnresolvedMergeSlots,
    diffCodePoints,
    type FormatPlan,
    type CodePointDiff,
} from './text-edit'
