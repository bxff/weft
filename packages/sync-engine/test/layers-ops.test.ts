/** Layer ops through the live session path (FakeDaemon round-trips). */

import { expect, test } from 'bun:test'
import { PageSession } from './page-session-harness'
import { FakeDaemon } from '../src/fake-daemon'
import { layerIdToRef } from '../src/apply-ops'
import { RmDocument, crdtIdKey } from '@weft/rm-format'
import { polylineToPoints } from '@weft/rm-ink/pure'

const DOC = 'doc-1'
const PAGE = 'page-1'
const AUTHOR = 'c8050a7c-0000-4000-a000-000000000001'

test('create layer -> draw on it -> visibility toggle, all round-tripped', async () => {
    const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
    const session = await PageSession.open(daemon, DOC, PAGE, {
        clientId: 'studio-1',
        authorUuid: AUTHOR,
        onPatch: () => {},
    })

    await session.apply([{ type: 'create-layer', label: 'Sketch' }])
    let doc = RmDocument.parse((await daemon.getPage(DOC, PAGE))!.bytes)
    const layers = doc.layers()
    expect(layers).toHaveLength(2)
    expect(layers[1]!.label).toBe('Sketch')

    // draw on the NEW layer via its stable ref
    const ref = layerIdToRef(doc, layers[1]!.nodeId)
    expect(ref.authorUuid).toBe(AUTHOR.toLowerCase())
    await session.apply([
        {
            type: 'upsert-shape',
            shape: {
                shapeId: 'shape:S1',
                kind: 'draw-native',
                props: {},
                x: 0,
                y: 0,
                rotation: 0,
                renderRevision: 'r1',
                version: { ts: 1, actor: 'test' },
            },
            parts: [
                {
                    partKey: 'stroke:0',
                    strokes: [
                        {
                            points: polylineToPoints(
                                [
                                    { x: 0, y: 0 },
                                    { x: 50, y: 50 },
                                ],
                                { width: 40 },
                            ),
                            color: 'black',
                        },
                    ],
                },
            ],
            layer: ref,
        },
    ])
    doc = RmDocument.parse((await daemon.getPage(DOC, PAGE))!.bytes)
    const target = doc.layers()[1]!.nodeId
    const lines = doc.blocks.filter((b) => b.type === 'sceneLineItem' && b.deletedLength === 0)
    expect(lines).toHaveLength(1)
    expect(crdtIdKey((lines[0] as { parentId: never }).parentId)).toBe(crdtIdKey(target))

    // visibility flip persists
    await session.apply([{ type: 'set-layer-visible', layer: ref, visible: false }])
    doc = RmDocument.parse((await daemon.getPage(DOC, PAGE))!.bytes)
    expect(doc.layers()[1]!.visible).toBe(false)
    session.close()
})
