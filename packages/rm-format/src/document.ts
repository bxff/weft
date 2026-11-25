/**
 * Whole-document API: the unit of read-mutate-serialize (ARCHITECTURE §5).
 *
 * An RmDocument is the parsed block list plus indexed views. Mutations are
 * block-level (append line items, tombstone items, register authors); writing
 * re-serializes everything in xochitl's layout. Blocks we could not parse
 * round-trip verbatim as RawBlocks.
 */

import { type CrdtId, crdtId, crdtIdKey, END_MARKER, RESERVED_CLOCK_FLOOR } from './crdt-id'
import {
    type RmBlock,
    type SceneLineItemBlock,
    type SceneImageItemBlock,
    type AuthorIdsBlock,
    readBlocks,
    writeBlocks,
} from './blocks'
import { type Line, type Image } from './scene-items'
import { lww, type LwwValue } from './crdt-id'
import { SceneTree, buildTree, displayedRootTextBlock } from './scene-tree'

export class RmDocument {
    readonly blocks: RmBlock[]

    private constructor(blocks: RmBlock[]) {
        this.blocks = blocks
    }

    static parse(data: ArrayBuffer | Uint8Array): RmDocument {
        return new RmDocument([...readBlocks(data)])
    }

    /** Create the minimal valid empty page (mirrors xochitl's structure). */
    static empty(authorUuid: string): RmDocument {
        const layer = crdtId(0, 11)
        const blocks: RmBlock[] = [
            {
                type: 'authorIds', version: { min: 0, current: 0 },
                extraData: EMPTY, authors: new Map([[1, authorUuid]]),
            },
            {
                // migrationId is the schema vintage marker: real device
                // files carry (1,1); older stamps can make xochitl treat the
                // file as pre-current-schema (breaks layer parsing).
                type: 'migrationInfo', version: { min: 1, current: 1 },
                extraData: EMPTY, migrationId: crdtId(1, 1), isDevice: true, unknown: false,
            },
            {
                type: 'pageInfo', version: { min: 0, current: 1 },
                extraData: EMPTY, loadsCount: 1, mergesCount: 0,
                textCharsCount: 0, textLinesCount: 0, typeFolioUseCount: 0,
            },
            {
                type: 'sceneTree', version: { min: 1, current: 1 },
                extraData: EMPTY, treeId: layer, nodeId: crdtId(0, 0),
                isUpdate: true, parentId: crdtId(0, 1),
            },
            {
                type: 'treeNode', version: { min: 1, current: 2 },
                extraData: EMPTY, nodeId: crdtId(0, 1),
                label: { timestamp: crdtId(0, 0), value: '' },
                visible: { timestamp: crdtId(0, 0), value: true },
                anchorId: null, anchorType: null, anchorThreshold: null, anchorOriginX: null,
            },
            {
                type: 'treeNode', version: { min: 1, current: 2 },
                extraData: EMPTY, nodeId: layer,
                label: { timestamp: crdtId(0, 12), value: 'Layer 1' },
                visible: { timestamp: crdtId(0, 0), value: true },
                anchorId: null, anchorType: null, anchorThreshold: null, anchorOriginX: null,
            },
            {
                type: 'sceneGroupItem', version: { min: 1, current: 1 },
                extraData: EMPTY, parentId: crdtId(0, 1), itemId: crdtId(0, 13),
                leftId: END_MARKER, rightId: END_MARKER, deletedLength: 0,
                nodeId: layer, extraValueData: EMPTY,
            },
        ]
        return new RmDocument(blocks)
    }

    serialize(): Uint8Array {
        return writeBlocks(this.blocks)
    }

    get rootTextBlock() {
        return displayedRootTextBlock(this.blocks)
    }

    /** Fork for line additions and item tombstones. Ink replay only mutates
     * item block fields and the author maps. Payloads remain shared. */
    forkForInkEdits(): RmDocument {
        return new RmDocument(this.blocks.map((block) => {
            if (block.type === 'authorIds') return { ...block, authors: new Map(block.authors) }
            return 'itemId' in block ? { ...block } : block
        }))
    }

    tree(): SceneTree {
        return buildTree(this.blocks)
    }

    // --- authors (numbers are file-local; resolve by UUID per document) ---

    authorTable(): Map<number, string> {
        // xochitl appends a new authorIds block when an author joins a page
        // instead of rewriting the first one, so a file can carry several.
        // Merge them all (later blocks win per index): reading only the
        // first block makes later authors' strokes resolve to a null ref
        // and silently vanish from the render.
        const merged = new Map<number, string>()
        for (const block of this.blocks) {
            if (block.type === 'authorIds') {
                for (const [index, uuid] of block.authors) merged.set(index, uuid)
            }
        }
        return merged
    }

    /** Author index for `uuid`, registering it in the table if missing.
     *  Scans EVERY authorIds block (see authorTable) both to find an
     *  existing registration and to avoid index collisions with authors
     *  registered in later blocks. */
    resolveAuthor(uuid: string, reservedSlots?: ReadonlySet<number>): number {
        const merged = this.authorTable()
        for (const [index, existing] of merged) {
            if (index > 0 && existing.toLowerCase() === uuid.toLowerCase()) return index
        }
        const widthSlots = new Set<number>()
        for (const block of this.blocks) {
            if (block.type === 'rootText' && block.widthData?.register) {
                widthSlots.add(block.widthData.register.timestamp.part1)
            }
        }
        let index = 1
        while (merged.has(index) || reservedSlots?.has(index) || widthSlots.has(index)) index++
        if (index > 0xff) throw new Error('No author slots remain in the page')
        let table: AuthorIdsBlock | null = null
        for (const block of this.blocks) {
            if (block.type === 'authorIds') {
                table = block
                break
            }
        }
        if (!table) {
            table = {
                type: 'authorIds', version: { min: 0, current: 0 },
                extraData: EMPTY, authors: new Map(),
            }
            this.blocks.unshift(table)
        }
        table.authors.set(index, uuid)
        return index
    }

    /**
     * GLOBAL highest clock across ALL authors and every CrdtId in the file —
     * not just item ids, but every minted timestamp (treeNode label/visible,
     * sceneInfo currentLayer, rootText styles, image lww). Deep-scans blocks.
     *
     * DEVICE-CRITICAL (Lamport clock): reMarkable's per-author clocks are NOT
     * independent — every new id continues from the GLOBAL maximum, so a new
     * item always causally dominates anything it could reference. xochitl
     * enforces this on load: an item whose clock is ≤ its left-origin's clock
     * is rejected as "invalid origin" (the whole layer/stroke is dropped).
     * The default layer's group item is 0:13, so the FIRST id any author
     * mints must have clock > 13 — a per-author "start at 1" produces 1:4,
     * clock 4 < 13, and the created layer silently fails to render.
     *
     * The optional authorIndex is ignored (kept for call-site compatibility):
     * the clock is global by construction.
     */
    maxClock(_authorIndex?: number): number {
        let max = 0
        const visit = (value: unknown): void => {
            if (!value || typeof value !== 'object') return
            const obj = value as Record<string, unknown>
            if (typeof obj.part1 === 'number' && typeof obj.part2 === 'number') {
                // Reserved anchor sentinels (2^48-2/-1) are NOT clocks — counting
                // them poisons every subsequent minted id to 2^48+ (runaway dup).
                if (obj.part2 > max && obj.part2 < RESERVED_CLOCK_FLOOR) max = obj.part2
                return // a CrdtId is a leaf
            }
            if (value instanceof Uint8Array) return
            if (value instanceof Map) {
                for (const v of value.values()) visit(v)
                return
            }
            if (Array.isArray(value)) {
                for (const v of value) visit(v)
                return
            }
            for (const v of Object.values(obj)) visit(v)
        }
        for (const block of this.blocks) visit(block)
        // Root-text runs occupy IMPLICIT per-char ids (itemId.part2 .. +len-1)
        // that exist nowhere as stored CrdtIds. Ignoring them let a fresh
        // edit mint a clock BELOW its own left reference; xochitl enforces
        // causality and silently drops such an item.
        for (const block of this.blocks) {
            if ('itemId' in block && 'deletedLength' in block && block.deletedLength > 0) {
                // Deleted scene ranges reserve every covered ID, not just the stored first ID.
                max = Math.max(max, block.itemId.part2 + block.deletedLength - 1)
            }
            if (block.type !== 'rootText') continue
            for (const item of block.textItems) {
                const span =
                    item.deletedLength > 0
                        ? item.deletedLength
                        : typeof item.value === 'string'
                          ? Math.max(1, [...item.value].length)
                          : 1
                const tail = item.itemId.part2 + span - 1
                if (tail > max) max = tail
            }
        }
        return max
    }

    /** Layers: live group items under the ROOT, with treeNode metadata.
     *  The parent check is load-bearing: web-drawn shapes wrap their strokes
     *  in groups nested UNDER a layer, so without it a heavily edited page
     *  lists hundreds of "layers", one per shape. Only root children are
     *  layers. */
    layers(): { nodeId: CrdtId; itemId: CrdtId; label: string; visible: boolean }[] {
        const meta = new Map<string, { label: string; visible: boolean }>()
        for (const block of this.blocks) {
            if (block.type === 'treeNode') {
                meta.set(crdtIdKey(block.nodeId), {
                    label: block.label.value,
                    visible: block.visible.value,
                })
            }
        }
        const rootKey = crdtIdKey(crdtId(0, 1))
        const out: { nodeId: CrdtId; itemId: CrdtId; label: string; visible: boolean }[] = []
        for (const block of this.blocks) {
            if (block.type !== 'sceneGroupItem' || block.deletedLength > 0 || !block.nodeId) continue
            if (crdtIdKey(block.parentId) !== rootKey) continue
            const m = meta.get(crdtIdKey(block.nodeId))
            out.push({
                nodeId: block.nodeId,
                itemId: block.itemId,
                label: m?.label ?? '',
                visible: m?.visible ?? true,
            })
        }
        return out
    }

    /** Text-anchored groups: handwriting written near typed text is wrapped
     *  in a group whose treeNode carries an anchor — a character id in the
     *  root text (or a start/end-of-text sentinel, see ANCHOR_TEXT_START/
     *  ANCHOR_TEXT_END) plus the anchor's X at write time. The device
     *  renders those groups RELATIVE to the anchor's current laid-out
     *  position; a renderer that ignores this scatters the ink. */
    anchoredGroups(): { nodeId: CrdtId; anchorId: CrdtId; anchorType: number | null; originX: number | null }[] {
        const out: { nodeId: CrdtId; anchorId: CrdtId; anchorType: number | null; originX: number | null }[] = []
        for (const block of this.blocks) {
            if (block.type !== 'treeNode' || !block.anchorId) continue
            out.push({
                nodeId: block.nodeId,
                anchorId: block.anchorId.value,
                anchorType: block.anchorType?.value ?? null,
                originX: block.anchorOriginX?.value ?? null,
            })
        }
        return out
    }

    /** Flip a layer's visibility (treeNode visible LWW; fresh timestamp). */
    setLayerVisible(nodeId: CrdtId, visible: boolean, opts: { authorUuid: string }): boolean {
        const author = this.resolveAuthor(opts.authorUuid)
        for (const block of this.blocks) {
            if (block.type === 'treeNode' && crdtIdKey(block.nodeId) === crdtIdKey(nodeId)) {
                const ts = crdtId(author, this.maxClock(author) + 1)
                block.visible = lww(ts, visible) as LwwValue<boolean>
                return true
            }
        }
        return false
    }

    /**
     * Create a new layer: the same sceneTree + treeNode + sceneGroupItem
     * trio xochitl writes, ids from the caller's author clock, group item
     * chained at the ROOT's frontier (the append-adjacency rule below
     * applies to the root sequence too).
     */
    createLayer(label: string, opts: { authorUuid: string }): CrdtId {
        const author = this.resolveAuthor(opts.authorUuid)
        const root = crdtId(0, 1)
        const nodeId = crdtId(author, this.maxClock(author) + 1)
        const labelTs = crdtId(author, nodeId.part2 + 1)
        const itemId = crdtId(author, nodeId.part2 + 2)
        const currentTs = crdtId(author, nodeId.part2 + 3)

        // device-mirrored structure: versions sceneTree(1,1)/treeNode(1,2)/
        // groupItem(1,1), blocks grouped BY TYPE next to their kin, and
        // sceneInfo.currentLayer pointing at the new layer (xochitl switches
        // to it on create)
        const insertAfterLast = (type: RmBlock['type'], block: RmBlock) => {
            let at = -1
            for (let i = 0; i < this.blocks.length; i++) {
                if (this.blocks[i]!.type === type) at = i
            }
            if (at >= 0) this.blocks.splice(at + 1, 0, block)
            else this.blocks.push(block)
        }
        insertAfterLast('sceneTree', {
            type: 'sceneTree', version: { min: 1, current: 1 },
            extraData: EMPTY, treeId: nodeId, nodeId: crdtId(0, 0),
            isUpdate: true, parentId: root,
        })
        insertAfterLast('treeNode', {
            type: 'treeNode', version: { min: 1, current: 2 },
            extraData: EMPTY, nodeId,
            label: lww(labelTs, label),
            visible: lww(crdtId(0, 0), true),
            anchorId: null, anchorType: null, anchorThreshold: null, anchorOriginX: null,
        })
        insertAfterLast('sceneGroupItem', {
            type: 'sceneGroupItem', version: { min: 1, current: 1 },
            extraData: EMPTY, parentId: root, itemId,
            leftId: this.appendFrontier(root),
            rightId: END_MARKER, deletedLength: 0,
            nodeId, extraValueData: EMPTY,
        })

        // sceneInfo.currentLayer -> the new layer
        let info = this.blocks.find((b) => b.type === 'sceneInfo')
        if (info && info.type === 'sceneInfo') {
            info.currentLayer = lww(currentTs, nodeId)
        } else {
            // after authorIds/migrationInfo, before tree blocks (real layout)
            const at = this.blocks.findIndex((b) => b.type === 'sceneTree')
            const block: RmBlock = {
                type: 'sceneInfo', version: { min: 0, current: 1 },
                extraData: EMPTY,
                currentLayer: lww(currentTs, nodeId),
                backgroundVisible: null, rootDocumentVisible: null, paperSize: null,
            }
            if (at >= 0) this.blocks.splice(at, 0, block)
            else this.blocks.push(block)
        }
        return nodeId
    }

    /** First non-tombstoned layer (group) node id to parent new strokes under. */
    defaultLayerId(): CrdtId | null {
        for (const block of this.blocks) {
            if (block.type === 'sceneGroupItem' && block.deletedLength === 0 && block.nodeId) {
                return block.nodeId
            }
        }
        return null
    }

    /**
     * Append frontier: the id of the last item block in FILE order under
     * `parentId`. This — not toposort order — is the only safe `leftId` for
     * end-appends.
     *
     * DEVICE-CRITICAL: xochitl's merge requires insertion origins to be
     * adjacent in its own sequence view. Deriving `leftId` from toposorted
     * document order can produce a non-adjacent (left, END) pair, which
     * hard-hangs the tablet until the watchdog reboots it. Real files
     * contain tombstones with degenerate (0,0) origins preserved by
     * xochitl, so toposort order != append order. Toposort is for RENDER
     * order only.
     */
    appendFrontier(parentId: CrdtId): CrdtId {
        let last: CrdtId = END_MARKER
        const parentKey = crdtIdKey(parentId)
        for (const block of this.blocks) {
            switch (block.type) {
                case 'sceneLineItem':
                case 'sceneGlyphItem':
                case 'sceneTombstoneItem':
                // image AND group items share their parent's sequence:
                // skipping either hands out a non-adjacent leftId (see the
                // device-hang warning on appendFrontier above). Group items
                // matter for the ROOT's child sequence (layers).
                case 'sceneImageItem':
                case 'sceneGroupItem':
                    if (crdtIdKey(block.parentId) === parentKey) last = block.itemId
                    break
                default:
                    break
            }
        }
        return last
    }

    /**
     * Append a new stroke at the end of `parentId`'s children: leftId =
     * append frontier in file order, timestamp = the item's own id.
     */
    appendLine(line: Line, opts: { authorUuid: string; parentId?: CrdtId }): SceneLineItemBlock {
        return this.appendLines([line], opts)[0]!
    }

    /**
     * Batch append: computes the expensive global clock + append frontier
     * ONCE, then mints sequential ids chaining each new item onto the
     * previous (preserving frontier-adjacency and the global Lamport clock).
     * O(n) for the whole batch instead of O(n·k) — the per-stroke
     * maxClock/appendFrontier rescan was an O(n^2) page-build hot path.
     */
    appendLines(lines: Line[], opts: { authorUuid: string; parentId?: CrdtId }): SceneLineItemBlock[] {
        if (lines.length === 0) return []
        const author = this.resolveAuthor(opts.authorUuid)
        const parentId = opts.parentId ?? this.defaultLayerId()
        if (!parentId) throw new Error('document has no layer group to append into')
        let clock = this.maxClock()
        let left = this.appendFrontier(parentId)
        const out: SceneLineItemBlock[] = []
        for (const line of lines) {
            const itemId = crdtId(author, ++clock)
            out.push(this.pushLine(line, parentId, itemId, left))
            left = itemId // next item chains onto this one (frontier advances)
        }
        return out
    }

    /** Reuse the clock and frontiers during a synchronous run of appends.
     * Other writes may only tombstone existing items without changing IDs. */
    withLineAppender<T>(
        authorUuid: string,
        write: (
            append: (line: Line, parentId: CrdtId) => SceneLineItemBlock,
            appendBatch: (lines: Line[], parentId: CrdtId) => SceneLineItemBlock[],
        ) => T,
    ): T {
        let state: { author: number; clock: number } | undefined
        const frontiers = new Map<string, CrdtId>()
        let active = true
        const prepare = () => {
            if (!active) throw new Error('stroke append scope has ended')
            return state ??= { author: this.resolveAuthor(authorUuid), clock: this.maxClock() }
        }
        const append = (line: Line, parentId: CrdtId) => {
            // Use the serial allocator at reserved clocks, which maxClock ignores.
            const allocation = prepare()
            if (allocation.clock + 1 >= RESERVED_CLOCK_FLOOR) return this.appendLine(line, { authorUuid, parentId })
            const key = crdtIdKey(parentId)
            const left = frontiers.get(key) ?? this.appendFrontier(parentId)
            const itemId = crdtId(allocation.author, ++allocation.clock)
            frontiers.set(key, itemId)
            return this.pushLine(line, parentId, itemId, left)
        }
        const appendBatch = (lines: Line[], parentId: CrdtId) => {
            if (lines.length === 0) return []
            if (prepare().clock + lines.length >= RESERVED_CLOCK_FLOOR) {
                // A whole original batch may cross the reserved boundary.
                // Keep that batch intact and let subsequent calls rescan.
                frontiers.clear()
                state = undefined
                return this.appendLines(lines, { authorUuid, parentId })
            }
            return lines.map((line) => append(line, parentId))
        }
        try {
            return write(append, appendBatch)
        } finally {
            active = false
        }
    }

    private pushLine(line: Line, parentId: CrdtId, itemId: CrdtId, leftId: CrdtId): SceneLineItemBlock {
        const block: SceneLineItemBlock = {
            type: 'sceneLineItem', version: { min: 0, current: 2 },
            extraData: EMPTY, extraValueData: EMPTY,
            parentId, itemId, leftId,
            rightId: END_MARKER,
            deletedLength: 0,
            line: { ...line, timestamp: itemId },
        }
        this.blocks.push(block)
        return block
    }

    /**
     * REAL-ADJACENT origins for a mid-sequence insert (the z-order
     * integrator's core): given the desired position in the parent's
     * RENDER order (tree walk), return the (leftId, rightId) pair of the
     * items that are actually adjacent there in the document's CURRENT
     * sequence view. Origins must be adjacency-valid in xochitl's view;
     * these are, by construction, since they come from that view.
     * `beforeIndex` counts live items only; 0 = bottom, length = top
     * (equivalent to a frontier append).
     */
    originsAt(parentId: CrdtId, beforeIndex: number): { leftId: CrdtId; rightId: CrdtId } {
        const tree = this.tree()
        const parent = tree.get(parentId)
        if (!parent) return { leftId: this.appendFrontier(parentId), rightId: END_MARKER }
        const ordered = parent.children.entries().map(([id]) => id)
        const i = Math.max(0, Math.min(beforeIndex, ordered.length))
        return {
            leftId: i === 0 ? END_MARKER : ordered[i - 1]!,
            rightId: i >= ordered.length ? END_MARKER : ordered[i]!,
        }
    }

    /**
     * Insert a stroke at a chosen depth in the parent's render order.
     * GATED: the adjacency rules this relies on are verified, but live
     * xochitl-merge acceptance is not — do not default UI re-stacking onto
     * this until that's confirmed.
     */
    insertLineAt(
        line: Line,
        opts: { authorUuid: string; parentId?: CrdtId; beforeIndex: number },
    ): SceneLineItemBlock {
        const author = this.resolveAuthor(opts.authorUuid)
        const parentId = opts.parentId ?? this.defaultLayerId()
        if (!parentId) throw new Error('document has no layer group to insert into')
        const { leftId, rightId } = this.originsAt(parentId, opts.beforeIndex)
        const itemId = crdtId(author, this.maxClock(author) + 1)
        const block: SceneLineItemBlock = {
            type: 'sceneLineItem', version: { min: 0, current: 2 },
            extraData: EMPTY, extraValueData: EMPTY,
            parentId, itemId, leftId, rightId,
            deletedLength: 0,
            line: { ...line, timestamp: itemId },
        }
        this.blocks.push(block)
        return block
    }

    /**
     * Append an image placement with the same append semantics as
     * appendLine: frontier leftId, timestamp = own id. The caller is
     * responsible for the SceneImageInfo registry entry and the asset file
     * at <doc>/<page>/<filename>.
     */
    appendImage(image: Image, opts: { authorUuid: string; parentId?: CrdtId }): SceneImageItemBlock {
        const author = this.resolveAuthor(opts.authorUuid)
        const parentId = opts.parentId ?? this.defaultLayerId()
        if (!parentId) throw new Error('document has no layer group to append into')
        const itemId = crdtId(author, this.maxClock(author) + 1)
        const block: SceneImageItemBlock = {
            type: 'sceneImageItem', version: { min: 2, current: 2 },
            extraData: EMPTY, extraValueData: EMPTY,
            parentId, itemId,
            leftId: this.appendFrontier(parentId),
            rightId: END_MARKER,
            deletedLength: 0,
            image: { ...image, timestamp: itemId },
        }
        this.blocks.push(block)
        return block
    }

    /**
     * Tombstone an existing item in place (the CRDT deletion form xochitl
     * itself uses after merging: same id, deletedLength=1, no value).
     */
    /** The scene-line block carrying `itemId`, tombstoned or live, or null.
     *  Callers check `deletedLength` for liveness (per-part reuse needs the
     *  parent layer too, so the block itself is returned, not a boolean). */
    findLineItem(itemId: CrdtId): SceneLineItemBlock | null {
        const key = crdtIdKey(itemId)
        for (const block of this.blocks) {
            if (block.type === 'sceneLineItem' && crdtIdKey(block.itemId) === key) return block
        }
        return null
    }

    tombstone(itemId: CrdtId): boolean {
        let found = false
        for (const block of this.blocks) {
            switch (block.type) {
                case 'sceneLineItem':
                    if (crdtIdKey(block.itemId) === crdtIdKey(itemId)) {
                        block.deletedLength = Math.max(1, block.deletedLength)
                        block.line = null
                        block.extraValueData = EMPTY
                        found = true
                    }
                    break
                case 'sceneGlyphItem':
                    if (crdtIdKey(block.itemId) === crdtIdKey(itemId)) {
                        block.deletedLength = Math.max(1, block.deletedLength)
                        block.glyph = null
                        block.extraValueData = EMPTY
                        found = true
                    }
                    break
                case 'sceneImageItem':
                    if (crdtIdKey(block.itemId) === crdtIdKey(itemId)) {
                        block.deletedLength = Math.max(1, block.deletedLength)
                        block.image = null
                        block.extraValueData = EMPTY
                        found = true
                    }
                    break
                default:
                    break
            }
        }
        return found
    }

    /**
     * Normalize block layout to xochitl's serialization convention: metadata
     * blocks first (original relative order), then item blocks sorted by
     * (author, clock). Optional — files are valid either way.
     */
    normalizeLayout(): void {
        const isItem = (b: RmBlock) =>
            b.type === 'sceneLineItem' ||
            b.type === 'sceneGlyphItem' ||
            b.type === 'sceneTombstoneItem' ||
            b.type === 'sceneImageItem'
        const meta = this.blocks.filter((b) => !isItem(b))
        const items = this.blocks.filter(isItem) as Extract<
            RmBlock,
            { itemId: CrdtId }
        >[]
        items.sort((a, b) => a.itemId.part1 - b.itemId.part1 || a.itemId.part2 - b.itemId.part2)
        this.blocks.length = 0
        this.blocks.push(...meta, ...items)
    }
}

const EMPTY = new Uint8Array(0)
