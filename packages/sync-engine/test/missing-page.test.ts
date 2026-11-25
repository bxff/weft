/**
 * Un-annotated pages (no .rm file, common for PDFs): the session opens an
 * empty document and the first write creates the page.
 */

import { describe, expect, test } from 'bun:test'
import { PageSession } from './page-session-harness'
import { FakeDaemon } from '../src/fake-daemon'
import { polylineToPoints } from '@weft/rm-ink/pure'

describe('missing .rm page', () => {
    test('opens empty, first write creates the page on the daemon', async () => {
        const daemon = FakeDaemon.withMissingPage('pdfdoc', 'page-x')
        expect(await daemon.getPage('pdfdoc', 'page-x')).toBeNull()

        const session = await PageSession.open(daemon, 'pdfdoc', 'page-x', {
            clientId: 'c1',
            authorUuid: 'c8050a7c-0000-4000-a000-000000000001',
            onPatch: () => {},
        })
        expect(session.currentRevision).toBe('')

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
                        partKey: 'whole',
                        strokes: [
                            {
                                points: polylineToPoints(
                                    [
                                        { x: 10, y: 10 },
                                        { x: 50, y: 50 },
                                    ],
                                    { width: 40 },
                                ),
                                color: 'black',
                            },
                        ],
                    },
                ],
            },
        ])

        const page = await daemon.getPage('pdfdoc', 'page-x')
        expect(page).not.toBeNull()
        expect(page!.revision).toBe(session.currentRevision)
        expect(session.currentRevision).not.toBe('')

        // a second client opening the page sees the annotation
        const session2 = await PageSession.open(daemon, 'pdfdoc', 'page-x', {
            clientId: 'c2',
            authorUuid: 'c8050a7c-0000-4000-a000-000000000001',
            onPatch: () => {},
        })
        expect(session2.currentOverlay.shapes).toHaveLength(1)
        session.close()
        session2.close()
    })
})
