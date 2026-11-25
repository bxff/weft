/**
 * Device-authored blob writes for the migration specs. A page the tablet wrote
 * before op-mode existed is a legacy blob page (raw .rm, zero ops/snapshot)
 * until an op-mode read migrates it; these helpers PUT .rm bytes as the tablet
 * would to exercise that transition.
 *
 * Built with `@weft/rm-format` only, via dynamic import() of the package `src`
 * (same form as app.spec.ts / tablet-erase.ts). Avoid `@weft/sync-engine`:
 * importing that barrel gives rm-format a second module identity under
 * Playwright's per-file transform, breaking instanceof across the doc.
 */

import { CLOUD_ORIGIN, E2E_USER } from './cloud-mode'

// portable ids are (author, clock); reusing this author across pushes lets the
// store's line diff recognize a carried-through stroke and emit zero ops
const DEVICE_AUTHOR = 'aaaaaaaa-0000-4000-a000-000000000001'
const AUTH = { authorization: `Bearer dev:${E2E_USER}` }

/** Mint a device token via the web pairing flow (the "tablet" identity). */
export async function deviceToken(): Promise<string> {
    const r = await fetch(`${CLOUD_ORIGIN}/api/pair`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'migration-e2e-tablet' }),
    })
    if (!r.ok) throw new Error(`pair failed: ${r.status}`)
    return ((await r.json()) as { token: string }).token
}

/** Append `count` freehand strokes to `doc` (one sceneLineItem each). */
async function addStrokes(doc: unknown, count: number): Promise<void> {
    const { Pen, PenColor } = await import('../packages/rm-format/src/index')
    const { polylineToPoints } = await import('../packages/rm-ink/src/pure')
    const d = doc as {
        appendLine(line: unknown, opts: { authorUuid: string }): unknown
    }
    for (let i = 0; i < count; i++) {
        d.appendLine(
            {
                kind: 'line',
                color: PenColor.BLACK,
                tool: Pen.FINELINER_1,
                points: polylineToPoints(
                    [
                        { x: 10 + i * 40, y: 10 },
                        { x: 90 + i * 40, y: 120 },
                    ],
                    { width: 40 },
                ),
                thicknessScale: 1,
                startingLength: 0,
                timestamp: { part1: 0, part2: 0 },
                moveId: null,
            },
            { authorUuid: DEVICE_AUTHOR },
        )
    }
}

/** `.rm` bytes for a legacy blob page: `strokes` freehand lines. */
export async function inkRm(strokes: number): Promise<Uint8Array> {
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const doc = RmDocument.empty(DEVICE_AUTHOR)
    await addStrokes(doc, strokes)
    return doc.serialize()
}

/**
 * Two-push tablet history for the checkpoint-restore spec: `second` adds a
 * root-text column to `first`'s stroke. Shared stroke id -> zero-op diff, but
 * the structure change makes the diff incomplete, so the store folds a fresh
 * snapshot: a zero-op page with two checkpoints whose ink differs (1 vs 2 shapes).
 */
export async function migrationPushes(): Promise<{ first: Uint8Array; second: Uint8Array }> {
    const { RmDocument, createRootText, insertText } = await import(
        '../packages/rm-format/src/index'
    )
    const doc = RmDocument.empty(DEVICE_AUTHOR)
    await addStrokes(doc, 1)
    const first = doc.serialize()
    createRootText(doc, {})
    insertText(doc, null, 'tablet note', { authorUuid: DEVICE_AUTHOR })
    const second = doc.serialize()
    return { first, second }
}

/**
 * PUT `.rm` as a device (tablet). On a fresh page this is a legacy blob write;
 * on an op-mode page the store diffs it into ops or a folded snapshot.
 * `x-base-revision` is advisory on the op path.
 */
export async function devicePut(
    token: string,
    doc: string,
    page: string,
    bytes: Uint8Array,
    baseRevision = '',
): Promise<void> {
    const r = await fetch(`${CLOUD_ORIGIN}/api/documents/${doc}/pages/${page}/rm`, {
        method: 'PUT',
        headers: {
            'content-type': 'application/octet-stream',
            'x-device-token': token,
            'x-base-revision': baseRevision,
        },
        body: bytes as unknown as BodyInit,
    })
    if (!r.ok) throw new Error(`device PUT failed: ${r.status}`)
}

/**
 * Anchored-reflow pair: a root-text column plus one stroke in a group anchored
 * to text-end (the trio xochitl writes for ink under typed text). `second`
 * extends the text by three lines, moving the end anchor (and stroke) down;
 * pins the web-side reflow of anchored ink on device text growth.
 */
export async function anchoredReflowPushes(): Promise<{ first: Uint8Array; second: Uint8Array }> {
    const { RmDocument, createRootText, insertText, crdtId, Pen, PenColor } = await import(
        '../packages/rm-format/src/index'
    )
    const { polylineToPoints } = await import('../packages/rm-ink/src/pure')
    const doc = RmDocument.empty(DEVICE_AUTHOR)
    createRootText(doc, {})
    const firstChar = insertText(doc, null, 'alpha', { authorUuid: DEVICE_AUTHOR })
    const author = doc.resolveAuthor(DEVICE_AUTHOR)
    const layer = doc.defaultLayerId()!
    const ANCHOR_END = crdtId(0, 281474976710655)
    const nodeId = crdtId(author, doc.maxClock(author) + 1)
    doc.blocks.push(
        {
            type: 'sceneTree', version: { min: 1, current: 1 },
            extraData: new Uint8Array(0), treeId: nodeId, nodeId: crdtId(0, 0),
            isUpdate: true, parentId: layer,
        } as never,
        {
            type: 'treeNode', version: { min: 1, current: 2 },
            extraData: new Uint8Array(0), nodeId,
            label: { timestamp: crdtId(0, 0), value: '' },
            visible: { timestamp: crdtId(0, 0), value: true },
            anchorId: { timestamp: crdtId(author, nodeId.part2 + 1), value: ANCHOR_END },
            anchorType: { timestamp: crdtId(author, nodeId.part2 + 2), value: 2 },
            anchorThreshold: { timestamp: crdtId(author, nodeId.part2 + 3), value: 0 },
            anchorOriginX: { timestamp: crdtId(author, nodeId.part2 + 4), value: -341.375 },
        } as never,
        {
            type: 'sceneGroupItem', version: { min: 1, current: 1 },
            extraData: new Uint8Array(0), parentId: layer,
            itemId: crdtId(author, nodeId.part2 + 5),
            leftId: doc.appendFrontier(layer), rightId: crdtId(0, 0),
            deletedLength: 0, nodeId, extraValueData: new Uint8Array(0),
        } as never,
    )
    doc.appendLine(
        {
            kind: 'line', color: PenColor.BLACK, tool: Pen.FINELINER_1,
            points: polylineToPoints(
                [{ x: 10, y: 10 }, { x: 90, y: 60 }],
                { width: 40 },
            ),
            thicknessScale: 1, startingLength: 0,
            timestamp: { part1: 0, part2: 0 }, moveId: null,
        },
        { authorUuid: DEVICE_AUTHOR, parentId: nodeId },
    )
    const first = doc.serialize()
    const lastChar = crdtId(firstChar.part1, firstChar.part2 + 'alpha'.length - 1)
    insertText(doc, lastChar, '\nbeta\ngamma\ndelta', { authorUuid: DEVICE_AUTHOR })
    const second = doc.serialize()
    return { first, second }
}
