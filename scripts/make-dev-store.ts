/**
 * Build a synthetic xochitl store for local dev + E2E (no tablet needed).
 *
 *   bun scripts/make-dev-store.ts [outDir=.dev-store]
 *
 * Produces:
 *  - "Dev Notebook"  : one page with real Paper Pro ink (ferrari fixture)
 *  - "Centered Notes": synthetic page with CENTERED x coords (geometry pin)
 *  - "Tiny PDF"      : 1-page PDF with NO .rm page file (missing-rm + underlay)
 *  - templates/      : a test "P Lines small" SVG for the template endpoint
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    CrdtSequence,
    ParagraphStyle,
    crdtIdKey,
    RmDocument,
    Pen,
    PenColor,
    crdtId,
    lww,
    uuidToBytesLE,
    createRootText,
    insertText,
    insertFormatCode,
    setParagraphStyle,
    planFormatEdits,
    rootTextCharPositions,
    type SceneImageInfoBlock,
    type SceneImageItemBlock,
} from '../packages/rm-format/src/index'
import { polylineToPoints } from '../packages/rm-ink/src/points'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv[2] ?? join(ROOT, '.dev-store')
const STORE = join(OUT, 'xochitl')
const TEMPLATES = join(OUT, 'templates')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(STORE, { recursive: true })
mkdirSync(TEMPLATES, { recursive: true })

const now = `${Date.now()}`

function metadata(name: string, parent = ''): string {
    return JSON.stringify({
        visibleName: name,
        parent,
        type: 'DocumentType',
        lastModified: now,
        deleted: false,
        pinned: false,
        version: 1,
    })
}

function contentV2(pages: { id: string; template?: string; redir?: number }[], fileType = 'notebook'): string {
    return JSON.stringify({
        fileType: fileType === 'notebook' ? '' : fileType,
        formatVersion: 2,
        cPages: {
            pages: pages.map((p) => ({
                id: p.id,
                ...(p.template ? { template: { value: p.template } } : {}),
                ...(p.redir !== undefined ? { redir: { value: p.redir } } : {}),
            })),
        },
    })
}

// 1. Dev Notebook — real Paper Pro ink
{
    const docId = '11111111-1111-4111-a111-111111111111'
    const pageId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    mkdirSync(join(STORE, docId), { recursive: true })
    writeFileSync(join(STORE, `${docId}.metadata`), metadata('Dev Notebook'))
    writeFileSync(
        join(STORE, `${docId}.content`),
        contentV2([{ id: pageId, template: 'P Lines small' }]),
    )
    writeFileSync(
        join(STORE, docId, `${pageId}.rm`),
        readFileSync(join(ROOT, 'fixtures/ferrari-xochitl-rewritten-merge.rm')),
    )
}

// 2. Centered Notes — synthetic ink with centered x (Paper Pro convention)
{
    const docId = '22222222-2222-4222-a222-222222222222'
    const pageId = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'
    mkdirSync(join(STORE, docId), { recursive: true })
    writeFileSync(join(STORE, `${docId}.metadata`), metadata('Centered Notes'))
    writeFileSync(join(STORE, `${docId}.content`), contentV2([{ id: pageId }]))

    const doc = RmDocument.empty('f73f497f-0000-4000-a000-000000000000')
    // X spanning the centered page: x in [-700, 700]
    for (const [x1, y1, x2, y2] of [
        [-700, 200, 700, 1800],
        [700, 200, -700, 1800],
        [-700, 200, 700, 200],
    ] as const) {
        const pts = polylineToPoints(
            Array.from({ length: 50 }, (_, i) => ({
                x: x1 + ((x2 - x1) * i) / 49,
                y: y1 + ((y2 - y1) * i) / 49,
            })),
            { width: 60 },
        )
        doc.appendLine(
            {
                kind: 'line',
                tool: Pen.MARKER_2,
                color: PenColor.BLACK,
                thicknessScale: 2,
                startingLength: 0,
                timestamp: crdtId(0, 1),
                moveId: null,
                points: pts,
            },
            { authorUuid: 'f73f497f-0000-4000-a000-000000000000' },
        )
    }
    writeFileSync(join(STORE, docId, `${pageId}.rm`), doc.serialize())
}

// 2b. Offline Notes — dedicated to e2e/offline.spec.ts (test isolation)
{
    const docId = '44444444-4444-4444-a444-444444444444'
    const pageId = 'dddddddd-dddd-4ddd-addd-dddddddddddd'
    mkdirSync(join(STORE, docId), { recursive: true })
    writeFileSync(join(STORE, `${docId}.metadata`), metadata('Offline Notes'))
    writeFileSync(join(STORE, `${docId}.content`), contentV2([{ id: pageId }]))
    const doc = RmDocument.empty('f73f497f-0000-4000-a000-000000000000')
    doc.appendLine(
        {
            kind: 'line',
            tool: Pen.MARKER_2,
            color: PenColor.BLACK,
            thicknessScale: 2,
            startingLength: 0,
            timestamp: crdtId(0, 1),
            moveId: null,
            points: polylineToPoints(
                [
                    { x: -300, y: 300 },
                    { x: 300, y: 900 },
                ],
                { width: 60 },
            ),
        },
        { authorUuid: 'f73f497f-0000-4000-a000-000000000000' },
    )
    writeFileSync(join(STORE, docId, `${pageId}.rm`), doc.serialize())
}

// 3. Tiny PDF — no .rm page file (un-annotated)
{
    const docId = '33333333-3333-4333-a333-333333333333'
    const pageId = 'cccccccc-cccc-4ccc-accc-cccccccccccc'
    writeFileSync(join(STORE, `${docId}.metadata`), metadata('Tiny PDF'))
    writeFileSync(
        join(STORE, `${docId}.content`),
        contentV2([{ id: pageId, redir: 0 }], 'pdf'),
    )
    const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 445 594] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 60 >> stream
BT /F1 24 Tf 60 520 Td (Weft PDF underlay) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R /Size 6 >>
%%EOF`
    writeFileSync(join(STORE, `${docId}.pdf`), pdf)
}

// 2c. Image Notes — embedded photo (blocks 0x0E/0x0F + per-page asset dir)
{
    const docId = '88888888-8888-4888-a888-888888888888'
    const pageId = '99999999-9999-4999-a999-999999999999'
    const assetUuid = 'ab1e0001-0000-4000-a000-0000000000ab'
    mkdirSync(join(STORE, docId, pageId), { recursive: true })
    writeFileSync(join(STORE, `${docId}.metadata`), metadata('Image Notes'))
    writeFileSync(join(STORE, `${docId}.content`), contentV2([{ id: pageId }]))

    const doc = RmDocument.empty('f73f497f-0000-4000-a000-000000000000')
    doc.appendLine(
        {
            kind: 'line',
            tool: Pen.MARKER_2,
            color: PenColor.BLACK,
            thicknessScale: 2,
            startingLength: 0,
            timestamp: crdtId(0, 1),
            moveId: null,
            points: polylineToPoints(
                [
                    { x: -300, y: 100 },
                    { x: 300, y: 100 },
                ],
                { width: 60 },
            ),
        },
        { authorUuid: 'f73f497f-0000-4000-a000-000000000000' },
    )
    const layer = doc.defaultLayerId()!
    doc.blocks.push(
        {
            type: 'sceneImageInfo',
            version: { min: 3, current: 3 },
            extraData: new Uint8Array(0),
            images: [
                {
                    uuid: assetUuid,
                    filename: lww(crdtId(1, 103), `${assetUuid}.png`),
                    flags: lww(crdtId(1, 104), new Uint8Array([17, 0])),
                },
            ],
        } satisfies SceneImageInfoBlock,
        {
            type: 'sceneImageItem',
            version: { min: 2, current: 2 },
            extraData: new Uint8Array(0),
            parentId: layer,
            itemId: crdtId(1, 100),
            leftId: doc.appendFrontier(layer),
            rightId: crdtId(0, 0),
            deletedLength: 0,
            extraValueData: new Uint8Array(0),
            image: {
                kind: 'image',
                uuid: lww(crdtId(1, 101), uuidToBytesLE(assetUuid)),
                timestamp: crdtId(1, 102),
                vertices: [-250, 300, 0, 0, 250, 300, 1, 0, 250, 800, 1, 1, -250, 800, 0, 1],
                indices: [0, 1, 2, 2, 3, 0],
                filename: null,
            },
        } satisfies SceneImageItemBlock,
    )
    writeFileSync(join(STORE, docId, `${pageId}.rm`), doc.serialize())
    writeFileSync(
        join(STORE, docId, pageId, `${assetUuid}.png`),
        readFileSync(join(ROOT, 'fixtures/test-photo.png')),
    )
}

// 3b. Tiny EPUB — device layout after first open: .epub + converted .pdf
// sidecar (xochitl repaginates EPUBs to PDF; /file prefers the .pdf)
{
    const docId = '66666666-6666-4666-a666-666666666666'
    const pageId = 'ffffffff-ffff-4fff-afff-ffffffffffff'
    writeFileSync(join(STORE, `${docId}.metadata`), metadata('Tiny EPUB'))
    writeFileSync(
        join(STORE, `${docId}.content`),
        contentV2([{ id: pageId, redir: 0 }], 'epub'),
    )
    const epubPdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 445 594] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 58 >> stream
BT /F1 24 Tf 60 520 Td (Weft EPUB underlay) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R /Size 6 >>
%%EOF`
    writeFileSync(join(STORE, `${docId}.pdf`), epubPdf)
    writeFileSync(join(STORE, `${docId}.epub`), 'PKepub-stub')
}

// 2d. Grid Notes — synthetic JSON template DSL fixture
{
    const docId = 'aaaa0001-0000-4000-a000-0000000000aa'
    const pageId = 'aaaa0002-0000-4000-a000-0000000000aa'
    mkdirSync(join(STORE, docId), { recursive: true })
    writeFileSync(join(STORE, `${docId}.metadata`), metadata('Grid Notes'))
    writeFileSync(
        join(STORE, `${docId}.content`),
        contentV2([{ id: pageId, template: 'Weft Test Grid' }]),
    )
    const doc = RmDocument.empty('f73f497f-0000-4000-a000-000000000000')
    doc.appendLine(
        {
            kind: 'line',
            tool: Pen.MARKER_2,
            color: PenColor.BLACK,
            thicknessScale: 2,
            startingLength: 0,
            timestamp: crdtId(0, 1),
            moveId: null,
            points: polylineToPoints(
                [
                    { x: -200, y: 300 },
                    { x: 200, y: 700 },
                ],
                { width: 60 },
            ),
        },
        { authorUuid: 'f73f497f-0000-4000-a000-000000000000' },
    )
    writeFileSync(join(STORE, docId, `${pageId}.rm`), doc.serialize())
    writeFileSync(
        join(TEMPLATES, 'Weft Test Grid.template'),
        readFileSync(join(ROOT, 'fixtures/Weft Test Grid.template')),
    )
}

// 2e. Two Layers — layer panel + visibility + per-layer writes (E2E)
{
    const docId = 'bbbb0001-0000-4000-a000-0000000000bb'
    const pageId = 'bbbb0002-0000-4000-a000-0000000000bb'
    mkdirSync(join(STORE, docId), { recursive: true })
    writeFileSync(join(STORE, `${docId}.metadata`), metadata('Two Layers'))
    writeFileSync(join(STORE, `${docId}.content`), contentV2([{ id: pageId }]))
    const doc = RmDocument.empty('f73f497f-0000-4000-a000-000000000000')
    doc.appendLine(
        {
            kind: 'line',
            tool: Pen.MARKER_2,
            color: PenColor.BLACK,
            thicknessScale: 2,
            startingLength: 0,
            timestamp: crdtId(0, 1),
            moveId: null,
            points: polylineToPoints(
                [
                    { x: -400, y: 300 },
                    { x: -400, y: 700 },
                ],
                { width: 60 },
            ),
        },
        { authorUuid: 'f73f497f-0000-4000-a000-000000000000' },
    )
    const layer2 = doc.createLayer('Layer 2', {
        authorUuid: 'f73f497f-0000-4000-a000-000000000000',
    })
    doc.appendLine(
        {
            kind: 'line',
            tool: Pen.MARKER_2,
            color: PenColor.BLACK,
            thicknessScale: 2,
            startingLength: 0,
            timestamp: crdtId(0, 1),
            moveId: null,
            points: polylineToPoints(
                [
                    { x: 400, y: 300 },
                    { x: 400, y: 700 },
                ],
                { width: 60 },
            ),
        },
        { authorUuid: 'f73f497f-0000-4000-a000-000000000000', parentId: layer2 },
    )
    writeFileSync(join(STORE, docId, `${pageId}.rm`), doc.serialize())
}

// 2f. Typed Text — device RootText (read-only overlay; E2E + linearizer)
{
    const docId = 'dddd0001-0000-4000-a000-0000000000dd'
    const pageId = 'dddd0002-0000-4000-a000-0000000000dd'
    mkdirSync(join(STORE, docId), { recursive: true })
    writeFileSync(join(STORE, `${docId}.metadata`), metadata('Typed Text'))
    writeFileSync(join(STORE, `${docId}.content`), contentV2([{ id: pageId }]))
    const AUTHOR = 'f73f497f-0000-4000-a000-000000000000'
    const doc = RmDocument.empty(AUTHOR)
    // one of each mapped node kind (heading/plain/checkbox/bullet/nested
    // bullet2/empty), built via the same mutation API the web editor uses
    createRootText(doc, { posY: 200 })
    const value =
        'My Notes\nFirst point has weight\nTask one\nBullet item\nNested detail\n\nStep one\nStep two\nAfter the gap'
    insertText(doc, null, value, { authorUuid: AUTHOR })
    const chars = rootTextCharPositions(doc.tree().rootText!).filter((c) => !c.deleted)
    const anchorOf = (para: number) =>
        chars.find((c) => c.paragraphIndex === para && c.offset === -1)!.id
    setParagraphStyle(doc, crdtId(0, 0), ParagraphStyle.HEADING, { authorUuid: AUTHOR })
    setParagraphStyle(doc, anchorOf(2), ParagraphStyle.CHECKBOX, { authorUuid: AUTHOR })
    setParagraphStyle(doc, anchorOf(3), ParagraphStyle.BULLET, { authorUuid: AUTHOR })
    setParagraphStyle(doc, anchorOf(4), ParagraphStyle.BULLET2, { authorUuid: AUTHOR })
    // numbered list is device paragraph style 10
    setParagraphStyle(doc, anchorOf(6), 10, { authorUuid: AUTHOR })
    setParagraphStyle(doc, anchorOf(7), 10, { authorUuid: AUTHOR })
    // bold the word "weight" via inline format codes, like the web editor
    const flat = value.replace(/\n/g, '')
    const target = [...flat].map((_, i) => ({
        bold: i >= flat.indexOf('weight') && i < flat.indexOf('weight') + 'weight'.length,
        italic: false,
    }))
    const plan = planFormatEdits(doc.tree().rootText!, target)!
    for (const ins of plan.inserts) {
        let after = ins.afterId
        for (const code of ins.codes) {
            after = insertFormatCode(doc, after, code, { authorUuid: AUTHOR })
        }
    }
    writeFileSync(join(STORE, docId, `${pageId}.rm`), doc.serialize())
}

// 2g. Device Edited — real firmware-2026 file (sizes, numbered lists,
// device bold/italic); positioning ground truth
{
    const docId = 'eeee0001-0000-4000-a000-0000000000ee'
    const pageId = 'eeee0002-0000-4000-a000-0000000000ee'
    mkdirSync(join(STORE, docId), { recursive: true })
    writeFileSync(join(STORE, `${docId}.metadata`), metadata('Device Edited'))
    writeFileSync(join(STORE, `${docId}.content`), contentV2([{ id: pageId }]))
    writeFileSync(
        join(STORE, docId, `${pageId}.rm`),
        readFileSync(join(ROOT, 'fixtures/ferrari-text-sizes-numbered.rm')),
    )
}



// 4. Test template
writeFileSync(
    join(TEMPLATES, 'P Lines small.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" width="1404" height="1872" viewBox="0 0 1404 1872">` +
        Array.from({ length: 26 }, (_, i) => `<line x1="0" y1="${120 + i * 66}" x2="1404" y2="${120 + i * 66}" stroke="#d7d7d7" stroke-width="2"/>`).join('') +
        `</svg>`,
)

console.log(`dev store written to ${OUT}`)
console.log(
    `the e2e harness (scripts/e2e-serve.ts) runs rmsyncd as a sync agent against this store;\n` +
        `to seed a cloud manually: device/target/release/rmsyncd --no-dbus \\\n` +
        `  --xochitl-dir ${STORE} --templates-dir ${TEMPLATES} --cloud-config <cloud.json>`,
)
