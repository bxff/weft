/**
 * Read-side scene tree: assembles blocks into the layer/item hierarchy.
 *
 * The block list (see document.ts) remains the unit of mutation and
 * serialization; the tree is a derived view for rendering and ordering.
 */

import { type CrdtId, crdtId, crdtIdKey } from './crdt-id'
import { CrdtSequence } from './crdt-sequence'
import { type Group, type Text, type Image, type SceneItem, isGroup } from './scene-items'
import { type RmBlock, type RootTextBlock, toSequenceItem, bytesToUuidLE } from './blocks'

export const ROOT_ID: CrdtId = crdtId(0, 1)

export class SceneTree {
    private nodes = new Map<string, Group>()
    rootText: Text | null = null

    constructor() {
        this.nodes.set(crdtIdKey(ROOT_ID), emptyGroup(ROOT_ID))
    }

    get root(): Group {
        return this.nodes.get(crdtIdKey(ROOT_ID))!
    }

    get(nodeId: CrdtId): Group | undefined {
        return this.nodes.get(crdtIdKey(nodeId))
    }

    ensureNode(nodeId: CrdtId): Group {
        const key = crdtIdKey(nodeId)
        let node = this.nodes.get(key)
        if (!node) {
            node = emptyGroup(nodeId)
            this.nodes.set(key, node)
        }
        return node
    }

    /** Depth-first walk in document (CRDT) order, tombstones excluded. */
    *walk(group: Group = this.root): Generator<[CrdtId, SceneItem]> {
        for (const [id, item] of group.children.entries()) {
            yield [id, item]
            if (isGroup(item)) yield* this.walk(item)
        }
    }
}

function emptyGroup(nodeId: CrdtId): Group {
    return {
        kind: 'group',
        nodeId,
        children: new CrdtSequence<SceneItem>(),
        label: null,
        visible: null,
        anchorId: null,
        anchorType: null,
        anchorThreshold: null,
        anchorOriginX: null,
    }
}

/** The root text record selected for Weft's single-column view. */
export function displayedRootTextBlock(blocks: readonly RmBlock[]): RootTextBlock | null {
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]!
        if (block.type === 'rootText') return block
    }
    return null
}

export function buildTree(input: Iterable<RmBlock>): SceneTree {
    const blocks: readonly RmBlock[] = Array.isArray(input) ? input : [...input]
    const tree = new SceneTree()
    tree.rootText = displayedRootTextBlock(blocks)?.text ?? null
    // uuid -> filename; filled from SceneImageInfo blocks, applied after the
    // loop (block order between 0x0E and 0x0F is not guaranteed)
    const imageFiles = new Map<string, string>()
    const imageItems: Image[] = []
    for (const block of blocks) {
        switch (block.type) {
            case 'sceneTree':
                tree.ensureNode(block.treeId)
                break
            case 'treeNode': {
                const node = tree.ensureNode(block.nodeId)
                node.label = block.label
                node.visible = block.visible
                node.anchorId = block.anchorId
                node.anchorType = block.anchorType
                node.anchorThreshold = block.anchorThreshold
                node.anchorOriginX = block.anchorOriginX
                break
            }
            case 'sceneGroupItem': {
                if (block.nodeId === null) {
                    // tombstoned group reference: keep ordering info on the parent
                    tree.ensureNode(block.parentId).children.merge(
                        toSequenceItem<SceneItem>(block, null as unknown as SceneItem),
                    )
                    break
                }
                const child = tree.ensureNode(block.nodeId)
                tree.ensureNode(block.parentId).children.merge(toSequenceItem<SceneItem>(block, child))
                break
            }
            case 'sceneLineItem':
                tree.ensureNode(block.parentId).children.merge(
                    toSequenceItem<SceneItem>(block, block.line as SceneItem),
                )
                break
            case 'sceneGlyphItem':
                tree.ensureNode(block.parentId).children.merge(
                    toSequenceItem<SceneItem>(block, block.glyph as SceneItem),
                )
                break
            case 'sceneTombstoneItem':
                tree.ensureNode(block.parentId).children.merge(
                    toSequenceItem<SceneItem>(block, null as unknown as SceneItem),
                )
                break
            case 'sceneImageInfo':
                for (const entry of block.images) imageFiles.set(entry.uuid, entry.filename.value)
                break
            case 'sceneImageItem': {
                // Registry filenames are view data, not a mutation of the source block.
                const image = block.image ? { ...block.image } : null
                if (image) imageItems.push(image)
                tree.ensureNode(block.parentId).children.merge(
                    toSequenceItem<SceneItem>(block, image as SceneItem),
                )
                break
            }
            default:
                break
        }
    }
    for (const image of imageItems) {
        image.filename = imageFiles.get(bytesToUuidLE(image.uuid.value)) ?? null
    }
    return tree
}
