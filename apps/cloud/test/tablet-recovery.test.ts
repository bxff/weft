import { expect, spyOn, test } from 'bun:test'
import { RmDocument, crdtId, lww, uuidToBytesLE } from '@weft/rm-format'
import { encodeOp, encodeSnapshot } from '@weft/sync-engine'
import { startCloud } from '../src/server'

const user = 'recovery-test'
const doc = 'book'
const page = 'sheet'
const author = 'aaaaaaaa-0000-4000-a000-000000000001'
const asset = 'bbbbbbbb-0000-4000-a000-000000000002'
const filename = asset + '.png'
const recovery = { 'x-weft-recovery': '1' }
const hash = (data: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(data).digest('hex')

function imageDocument(missing: string) {
    const imagedPage = RmDocument.empty(author)
    // Match xochitl's registry and image records, but leave the promised file absent.
    imagedPage.blocks.push({
        type: 'sceneImageInfo', extraData: new Uint8Array(), version: { min: 1, current: 1 },
        images: [{ uuid: missing, filename: lww(crdtId(1, 11), missing + '.png'), flags: lww(crdtId(1, 12), new Uint8Array([17, 0])) }],
    })
    imagedPage.appendImage({
        kind: 'image', uuid: lww(crdtId(1, 12), uuidToBytesLE(missing)), timestamp: crdtId(0, 0),
        vertices: [0, 0, 0, 0, 10, 0, 1, 0, 10, 10, 1, 1], indices: [0, 1, 2], filename: null,
    }, { authorUuid: author })
    return imagedPage
}

test('tablet recovery pins overlay, native content and mutable asset versions', async () => {
    const previous = process.env.HOST
    process.env.HOST = '127.0.0.1'
    const cloud = startCloud({ port: 0, db: ':memory:' })
    try {
        const root = 'http://127.0.0.1:' + cloud.port + '/api'
        const url = root + '/documents/' + doc + '/pages/' + page
        const revisions = root + '/revisions'
        const device = { 'x-device-token': cloud.store.mintDeviceToken(user, 'tablet') }
        const other = { 'x-device-token': cloud.store.mintDeviceToken('other-user', 'other tablet') }
        const get = (path: string, headers: Record<string, string> = {}) =>
            fetch(path, { headers: { ...device, ...headers } })
        const putAsset = (body: string) => fetch(url + '/assets/' + filename, {
            method: 'PUT', headers: device, body,
        })
        const nativeDocument = RmDocument.empty(author)
        const native = nativeDocument.serialize()
        const nativeHash = hash(native)
        const initialSeq = cloud.store.putSnapshot(user, doc, page, encodeSnapshot(native, { shapes: [] }))
        const ordinary = await get(url + '/rm')
        expect(new Uint8Array(await ordinary.arrayBuffer())).toEqual(native)
        expect((await fetch(url + '/rm', { headers: { ...other, ...recovery } })).status).toBe(404)
        expect((await fetch(url + '/rm', { headers: recovery })).status).toBe(401)

        const blank = await get(url + '/rm', recovery)
        const firstTag = blank.headers.get('etag')!
        const initial = await blank.json() as any
        expect(initial).toMatchObject({
            revision: ordinary.headers.get('x-rm-revision'),
            snapshotSeq: initialSeq, opSeq: 0,
            nativeSha256: nativeHash, nativeBase64: Buffer.from(native).toString('base64'),
            assetRevision: '', overlay: { shapes: [] }, assets: [], missingAssets: [],
        })
        expect((await get(url + '/rm', { ...recovery, 'if-none-match': firstTag })).status).toBe(200)
        const sameNative = { ...recovery, 'x-weft-native-sha256': nativeHash }
        expect((await get(url + '/rm', { ...sameNative, 'if-none-match': firstTag })).status).toBe(304)

        const props = { weftArrowLinks: [{ toId: 'shape:target', props: { terminal: 'start' } }] }
        cloud.store.appendOps(user, doc, page, [encodeOp({
            op: 'upsert-object', id: 'shape:arrow', objType: 'arrow', props, rendered: [],
            transform: { x: 0, y: 0, rotation: 0 }, version: { actor: author, ts: 1 },
        })], 'browser')
        const tail = await get(url + '/rm', { ...sameNative, 'if-none-match': firstTag })
        const tailTag = tail.headers.get('etag')!
        const tailData = await tail.json() as any
        expect(tailData).toMatchObject({
            nativeBase64: null, snapshotSeq: initialSeq,
            overlay: { shapes: [{ shapeId: 'shape:arrow', props }] },
        })
        expect(tailData.opSeq).toBeGreaterThan(0)

        const replacement = cloud.store.putSnapshot(
            user, doc, page, encodeSnapshot(native, { shapes: [] }), false, tailData.opSeq,
        )
        const replaced = await get(url + '/rm', { ...sameNative, 'if-none-match': tailTag })
        expect(await replaced.json()).toMatchObject({
            nativeBase64: null, snapshotSeq: replacement, opSeq: tailData.opSeq, overlay: { shapes: [] },
        })

        const photoPage = imageDocument(asset).serialize()
        cloud.store.putSnapshot(user, doc, page, encodeSnapshot(photoPage, { shapes: [] }))
        const photoNative = { ...recovery, 'x-weft-native-sha256': hash(photoPage) }
        const firstSweep = await get(revisions, recovery)
        const firstSweepTag = firstSweep.headers.get('etag')!
        const firstSweepData = await firstSweep.json() as any
        const scan = spyOn(cloud.store, 'pageRevisions')
        expect((await get(revisions, { ...recovery, 'if-none-match': firstSweepTag })).status).toBe(304)
        expect(scan).not.toHaveBeenCalled()
        scan.mockRestore()
        expect((await putAsset('image v1')).status).toBe(200)
        const secondSweep = await get(revisions, { ...recovery, 'if-none-match': firstSweepTag })
        const secondSweepData = await secondSweep.json() as any
        expect(secondSweepData.pages).toEqual(firstSweepData.pages)
        expect(secondSweepData.assets[doc + '/' + page]).toBeString()

        const firstAsset = await get(url + '/rm', photoNative)
        const assetTag = firstAsset.headers.get('etag')!
        expect(await firstAsset.json()).toMatchObject({
            assetRevision: secondSweepData.assets[doc + '/' + page],
            assets: [{ name: filename, sha256: hash('image v1') }],
        })
        expect((await putAsset('image v2')).status).toBe(200)
        const newer = await get(url + '/rm', { ...photoNative, 'if-none-match': assetTag, 'accept-encoding': 'gzip' })
        expect(newer.headers.get('content-encoding')).toBe('gzip')
        expect(await newer.json()).toMatchObject({
            nativeBase64: null,
            assets: [{ name: filename, sha256: hash('image v2') }],
        })

        const missing = 'cccccccc-0000-4000-a000-000000000003'
        const imagedPage = imageDocument(missing)
        cloud.store.putSnapshot(user, doc, page, encodeSnapshot(imagedPage.serialize(), { shapes: [] }))
        expect(await (await get(url + '/rm', recovery)).json()).toMatchObject({
            missingAssets: [missing + '.png'], assets: [],
        })
        const [imageId] = [...imagedPage.tree().walk()].find(([, item]) => item.kind === 'image')!
        expect(imagedPage.tombstone(imageId)).toBe(true)
        cloud.store.putSnapshot(user, doc, page, encodeSnapshot(imagedPage.serialize(), { shapes: [] }))
        expect(await (await get(url + '/rm', recovery)).json()).toMatchObject({
            missingAssets: [], assets: [],
        })

        const legacyPage = 'legacy'
        cloud.store.putPage(user, doc, legacyPage, '', native, 'test')
        const beforeLegacy = await get(revisions, recovery)
        cloud.store.putOverlay(user, doc, legacyPage, JSON.stringify({ shapes: [], tombstones: {} }))
        const afterLegacy = await get(revisions, { ...recovery, 'if-none-match': beforeLegacy.headers.get('etag')! })
        expect(afterLegacy.status).toBe(200)
        const legacyData = await afterLegacy.json() as any
        expect(legacyData.assets[doc + '/' + legacyPage]).toBeString()
        expect(await (await get(root + '/documents/' + doc + '/pages/' + legacyPage + '/rm', recovery)).json())
            .toMatchObject({ assetRevision: legacyData.assets[doc + '/' + legacyPage], overlay: { shapes: [], tombstones: {} } })
        const legacyRm = root + '/documents/' + doc + '/pages/' + legacyPage + '/rm'
        cloud.store.putOverlay(user, doc, legacyPage, JSON.stringify({
            shapes: [{ props: { caption: 'x'.repeat(16 * 1024 * 1024) } }],
        }))
        const oversized = await get(legacyRm, recovery)
        expect(oversized.status).toBe(413)
        expect(await oversized.json()).toEqual({ error: 'Recovery page exceeds size limit' })
        expect(new Uint8Array(await (await get(legacyRm)).arrayBuffer())).toEqual(native)
    } finally {
        cloud.stop()
        if (previous === undefined) delete process.env.HOST
        else process.env.HOST = previous
    }
})
