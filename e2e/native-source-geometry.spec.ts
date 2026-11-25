import { readFile } from 'node:fs/promises'
import { RM_SCALE } from '../packages/rm-ink/src/pen'
import { encodeSnapshot } from '../packages/sync-engine/src/snapshot'
import { expect, test, type Page } from "@playwright/test";
import type { Editor } from "tldraw";
import { CLOUD_ORIGIN, E2E_USER, useCloudMode } from "./cloud-mode";
import { devicePut, deviceToken, inkRm } from "./device-blob";

useCloudMode();

async function readInk(page: Page) {
  return page.evaluate(() => {
    const editor = (window as unknown as { __weftEditor?: Editor })
      .__weftEditor;
    return (
      editor
        ?.getCurrentPageShapesSorted()
        .filter((s) => s.type === "draw")
        .map(({ id, index, x, y, props, meta }) => ({
          id,
          index,
          x,
          y,
          props,
          meta,
        })) ?? []
    );
  });
}

for (const scenario of ['cold', 'resized', 'dense reopen'] as const) {
    const resized = scenario === 'resized'
    const count = scenario === 'dense reopen' ? 320 : 2
    test(`device snapshot refreshes the same selected stroke (${scenario})`, async ({ page }) => {
        const { RmDocument } = await import('../packages/rm-format/src/index')
        const doc = '11111111-1111-4111-a111-111111111111'
        const sheet = crypto.randomUUID()
        const token = await deviceToken()
        const bytes = await inkRm(count)
        await devicePut(token, doc, sheet, bytes)
        await page.goto(`/app/${doc}/${sheet}`)
        await expect.poll(async () => (await readInk(page)).length).toBe(count)
        if (scenario === 'dense reopen') {
            await expect(page.getByTestId('sync-status')).toHaveText('synced')
            await page.reload()
            await expect.poll(async () => (await readInk(page)).length).toBe(count)
        }
        const before = await readInk(page)
        const untouched = before[0]!
        const edited = before.at(-1)!
        if (resized) {
            await page.evaluate((id) => {
                const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
                editor.updateShape({ id, type: 'draw', props: { scaleX: 2, scaleY: 2 } })
            }, edited!.id)
            await expect.poll(async () => {
                const bytes = new Uint8Array(await (await page.request.get(`/api/documents/${doc}/pages/${sheet}/rm`)).body())
                return RmDocument.parse(bytes).blocks.filter((block) => block.type === 'sceneLineItem').length
            }).toBe(3)
            await expect(page.getByTestId('sync-status')).toHaveText('synced')
            expect((await readInk(page))[1]!.props.scaleX).toBe(2)
        }
        await page.evaluate((id) => {
            (window as unknown as { __weftEditor: Editor }).__weftEditor.select(id)
        }, edited!.id)
        const path = `/api/documents/${doc}/pages/${sheet}/rm`
        const head = await page.request.get(path)
        const rm = RmDocument.parse(new Uint8Array(await head.body()))
        const stroke = rm.blocks.filter((b) => b.type === 'sceneLineItem' && b.line).at(-1)!
        if (stroke.type !== 'sceneLineItem' || !stroke.line) throw Error('Expected an ink stroke')
        for (const point of stroke.line.points) point.x += 200
        // An exact native checkpoint preserves the source identity. The tablet
        // endpoint's independent clone-collision policy is tested separately.
        const checkpoint = path.replace(/\/rm$/, '/snapshot')
        expect((await page.request.put(checkpoint, { data: Buffer.from(encodeSnapshot(rm.serialize(), { shapes: [] })) })).ok())
            .toBe(true)
        const latest = async () => RmDocument.parse(new Uint8Array(await (await page.request.get(path)).body()))
        expect((await latest()).findLineItem(stroke.itemId)?.line?.points[0]?.x).toBe(stroke.line.points[0]!.x)
        await expect.poll(async () => (await readInk(page)).at(-1)?.x).toBeGreaterThan(edited!.x)
        const after = await readInk(page)
        expect(after[0]).toEqual(untouched!)
        expect(after.at(-1)!.id).toBe(edited!.id)
        expect(after.at(-1)!.props).toMatchObject({ scaleX: 1, scaleY: 1 })
        expect(await page.evaluate(() => (window as unknown as { __weftEditor: Editor }).__weftEditor.getSelectedShapeIds())).toEqual([edited!.id])
        const start = stroke.line.points[0]!.x
        const displacement = 64
        await page.evaluate(({ id, x, dx }) => {
            const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
            editor.focus()
            editor.markHistoryStoppingPoint('move updated native ink')
            editor.updateShape({ id, type: 'draw', x: x + dx })
        }, { id: after.at(-1)!.id, x: after.at(-1)!.x, dx: displacement * RM_SCALE })
        const lastInkX = async () => [...(await latest()).tree().walk()]
            .flatMap(([, item]) => item.kind === 'line' ? [item.points[0]!.x] : []).at(-1)
        await expect.poll(lastInkX).toBe(start + displacement)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        await page.keyboard.press('ControlOrMeta+z')
        await expect.poll(lastInkX).toBe(start)
    })
}

async function openNativeImage(page: Page, beforeOpen?: (asset: string) => Promise<void>, count = 1, withInk = false) {
  const { Pen, PenColor, RmDocument, crdtId, lww, uuidToBytesLE } = await import("../packages/rm-format/src/index");
  const doc = "11111111-1111-4111-a111-111111111111";
  const sheet = crypto.randomUUID();
  const photos = Array.from({ length: count }, () => crypto.randomUUID());
  const asset = photos[0]!;
  const author = "aaaaaaaa-0000-4000-a000-000000000001";
  const rm = RmDocument.empty(author);
  if (withInk) rm.appendLine({
    kind: 'line', color: PenColor.BLACK, tool: Pen.FINELINER_1,
    points: [{ x: 10, y: 10 }, { x: 90, y: 120 }].map(point => ({
      ...point, width: 40, speed: 0, direction: 0, pressure: 255,
    })),
    thicknessScale: 1, startingLength: 0, timestamp: crdtId(0, 0), moveId: null,
  }, { authorUuid: author });

  rm.blocks.push({type: "sceneImageInfo", version: { min: 3, current: 3 }, extraData: new Uint8Array(),
    images: photos.map((uuid, i) => ({ uuid, filename: lww(crdtId(1, 50 + i), uuid + '.png'),
      flags: lww(crdtId(1, 60 + i), new Uint8Array([17, 0])) })) });
  for (const [i, uuid] of photos.entries()) {
    const x = i * 200;
    rm.appendImage({ kind: 'image', uuid: lww(crdtId(1, 70 + i), uuidToBytesLE(uuid)), timestamp: crdtId(0, 0),
      vertices: [x,200,0,0,x+100,200,1,0,x+100,300,1,1,x,300,0,1],
      indices: [0,1,2,2,3,0], filename: null }, { authorUuid: author });
  }
  const token = await deviceToken();
  await devicePut(token, doc, sheet, rm.serialize());
  const pixels = await readFile('fixtures/test-photo.png');
  for (const uuid of photos) {
    expect((await page.request.put(`/api/documents/${doc}/pages/${sheet}/assets/${uuid}.png`, { data: pixels })).ok()).toBe(true);
  }
  await beforeOpen?.(asset)
  await page.goto(`/app/${doc}/${sheet}`);
  return { doc, sheet, asset, photos, token }
}

test('packing the accepted photo into a checkpoint leaves its browser move undoable', async ({ page }) => {
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const { doc, sheet } = await openNativeImage(page)
    const endpoint = `/api/documents/${doc}/pages/${sheet}`
    const shape = () => page.evaluate(() => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        return editor?.getCurrentPageShapes().find(item => item.type === 'image')
    })
    const photo = () => page.request.get(endpoint + '/rm').then(async response =>
        [...RmDocument.parse(new Uint8Array(await response.body())).tree().walk()].find(([, item]) => item.kind === 'image')?.[1])
    await expect.poll(shape).toBeTruthy()
    const original = (await shape())!
    const movedX = 317.125
    await page.evaluate(({ id, x }) => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        editor.focus()
        editor.markHistoryStoppingPoint('move native photo')
        editor.updateShape({ id, type: 'image', x, rotation: 0.31 })
    }, { id: original.id, x: movedX })
    const nativeX = async () => {
        const item = await photo()
        return item?.kind === 'image' ? item.vertices[0]! * RM_SCALE : NaN
    }
    await expect.poll(nativeX).toBeCloseTo(movedX, 3)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    expect((await shape())?.x).toBe(movedX)
    const native = new Uint8Array(await (await page.request.get(endpoint + '/rm')).body())
    const checkpoint = encodeSnapshot(native, { shapes: [] })
    expect((await page.request.put(endpoint + '/snapshot', { data: Buffer.from(checkpoint) })).ok()).toBe(true)
    // Wait for the browser to apply the float32 round-trip difference.
    await expect.poll(async () => (await shape())?.x).not.toBe(movedX)
    expect((await shape())?.meta.weftNativeGeometry).toBe(original.meta.weftNativeGeometry)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(nativeX).toBeCloseTo(original.x, 3)
})

test('flushing a different photo keeps Undo behind a deferred tablet change', async ({ page }) => {
    const { RmDocument, bytesToUuidLE } = await import('../packages/rm-format/src/index')
    const { doc, sheet, photos, token } = await openNativeImage(page, undefined, 3)
    const [moved, selected, witness] = photos as [string, string, string]
    const path = `/api/documents/${doc}/pages/${sheet}/rm`
    const canvas = () => page.evaluate(() => {
        const editor = (window as unknown as { __weftEditor?: Editor }).__weftEditor
        return editor?.getCurrentPageShapes().flatMap(shape => shape.type === 'image' ? [{
            id: shape.id, uuid: shape.meta.weftNativeImageUuid, x: shape.x,
            generation: Number(shape.meta.weftNativeGeometry ?? 0),
        }] : []) ?? []
    })
    const image = async (uuid: string) => (await canvas()).find(shape => shape.uuid === uuid)!
    const nativeX = async (uuid: string) => {
        const bytes = new Uint8Array(await (await page.request.get(path)).body())
        for (const [, item] of RmDocument.parse(bytes).tree().walk()) {
            if (item.kind === 'image' && bytesToUuidLE(item.uuid.value) === uuid) return item.vertices[0]!
        }
        return NaN
    }
    await expect.poll(async () => (await canvas()).length).toBe(3)
    const a = await image(moved), b = await image(selected), c = await image(witness)
    await page.evaluate(({ id, x }) => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        editor.focus()
        editor.markHistoryStoppingPoint('move selected photo')
        editor.updateShape({ id, type: 'image', x })
    }, { id: b.id, x: 250 * RM_SCALE })
    await expect.poll(() => nativeX(selected)).toBeCloseTo(250)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')

    await page.evaluate(id => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        editor.select(id)
        // Hold the deferral state while the peer update and queued move arrive.
        editor.inputs.getIsPointing = () => true
    }, b.id)
    const head = await page.request.get(path)
    const tablet = RmDocument.parse(new Uint8Array(await head.body()))
    for (const block of tablet.blocks) {
        if (block.type !== 'sceneImageItem' || block.deletedLength || !block.image) continue
        const uuid = bytesToUuidLE(block.image.uuid.value)
        if (uuid === selected || uuid === witness) {
            for (const i of [0, 4, 8, 12]) block.image.vertices[i]! += 45
        }
    }
    await devicePut(token, doc, sheet, tablet.serialize(), head.headers()['x-rm-revision'])
    await expect.poll(async () => (await image(witness))?.x).toBeCloseTo(c.x + 45 * RM_SCALE)
    expect((await image(selected)).x).toBeCloseTo(250 * RM_SCALE)
    await page.evaluate(({ id, x }) => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        editor.run(() => editor.updateShape({ id, type: 'image', x }), { history: 'ignore' })
        // SDK 5.6 projects native gestures on pointer-up before applying deferred source updates.
        editor.inputs.getIsPointing = () => false
    }, { id: a.id, x: 50 * RM_SCALE })
    await expect.poll(() => nativeX(moved)).toBeCloseTo(50)
    await expect.poll(async () => (await image(selected)).x).toBeCloseTo(295 * RM_SCALE)
    expect((await image(selected)).generation).toBe(b.generation + 1)
    await page.keyboard.press('ControlOrMeta+z')
    expect((await image(selected)).x).toBeCloseTo(295 * RM_SCALE)
    expect(await nativeX(selected)).toBeCloseTo(295)
})

test("a same-reference tablet image resize reaches the editor and survives a browser move", async ({ page }) => {
  const { RmDocument } = await import("../packages/rm-format/src/index")
  const { doc, sheet, token } = await openNativeImage(page)
  const image = () => page.evaluate(() => {
    const ed = (window as unknown as {__weftEditor?: Editor}).__weftEditor;
    const s = ed?.getCurrentPageShapes().find(s => s.type === "image");
    return s?.type === "image" ? {id: s.id, x: s.x, w: s.props.w, assetId: s.props.assetId} : null;
  });
  await expect.poll(image).not.toBeNull();
  const original = (await image())!;
  const path = `/api/documents/${doc}/pages/${sheet}/rm`;
  const head = await page.request.get(path);
  const update = RmDocument.parse(new Uint8Array(await head.body()));
  const block = update.blocks.find(b => b.type === "sceneImageItem" && b.image);
  if (block?.type !== "sceneImageItem" || !block.image) throw Error("Missing image");
  block.image.vertices[4] = 200;
  block.image.vertices[8] = 200;
  await devicePut(token, doc, sheet, update.serialize(), head.headers()["x-rm-revision"]);
  await expect.poll(image).toEqual({ ...original, w: original.w * 2 });
  await page.evaluate(({id,x}) => {
    (window as unknown as {__weftEditor: Editor}).__weftEditor.updateShape({id, type:"image", x: x + 64});
  }, original);
  // The committed snapshot must carry the twice-as-wide image at its moved origin.
  await expect.poll(async () => {
    const read = await page.request.get(path);
    const result = RmDocument.parse(new Uint8Array(await read.body()));
    const items = [...result.tree().walk()].flatMap(([, s]) => s.kind === "image" ? [s] : []);
    if (items.length !== 1) return null;
    const v = items[0]!.vertices;
    return [v[0]! > 0, Math.round(v[4]! - v[0]!)];
  }, { timeout: 30000 }).toEqual([true, 200]);
});

for (const status of ['settled', 'in flight'] as const) {
    test(`a native photo rename preserves its browser copy when the old asset is ${status}`, async ({ page }) => {
        const { RmDocument, crdtId, lww } = await import('../packages/rm-format/src/index')
        const originalBytes = await readFile('fixtures/test-photo.png')
        const newBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2sAAAAASUVORK5CYII=', 'base64')
        const srcFor = (bytes: Buffer) => 'data:image/png;base64,' + bytes.toString('base64')
        let releaseRequest!: () => void
        const gate = new Promise<void>(resolve => { releaseRequest = resolve })
        let requestStarted = false
        try {
            const { doc, sheet, asset, token } = await openNativeImage(page, async original => {
                if (status !== 'in flight') return
                await page.route(`**/assets/${original}.png`, async route => {
                    requestStarted = true
                    await gate
                    await route.fulfill({ body: originalBytes, contentType: 'image/png' })
                })
            })
            const images = (tab = page) => tab.evaluate(() => {
                const editor = (window as unknown as { __weftEditor?: Editor }).__weftEditor
                return editor?.getCurrentPageShapesSorted().flatMap(shape => {
                    if (shape.type !== 'image' || !shape.props.assetId) return []
                    const asset = editor.getAsset(shape.props.assetId)
                    if (asset?.type !== 'image') return []
                    return [{ id: shape.id, assetId: asset.id, file: asset.props.name, src: asset.props.src }]
                }) ?? []
            })
            await expect.poll(async () => (await images()).length).toBe(1)
            if (status === 'in flight') await expect.poll(() => requestStarted).toBe(true)
            else await expect.poll(async () => (await images())[0]?.src).toBe(srcFor(originalBytes))
            const original = (await images())[0]!
            await page.evaluate(id => {
                (window as unknown as { __weftEditor: Editor }).__weftEditor.duplicateShapes([id], { x: 150, y: 150 })
            }, original.id)
            const copy = (await images()).find(shape => shape.id !== original.id)!
            expect(copy.assetId).toBe(original.assetId)

            const endpoint = `/api/documents/${doc}/pages/${sheet}`
            const before = await page.request.get(endpoint + '/rm')
            const update = RmDocument.parse(new Uint8Array(await before.body()))
            const registry = update.blocks.find(block => block.type === 'sceneImageInfo')
            const entry = registry?.type === 'sceneImageInfo' && registry.images.find(entry => entry.uuid === asset)
            if (!entry) throw new Error('Missing native photo registry entry')
            const file = `renamed-${crypto.randomUUID()}.png`
            expect((await page.request.put(endpoint + '/assets/' + file, { data: newBytes })).ok()).toBe(true)
            entry.filename = lww(crdtId(1, 70), file)
            await devicePut(token, doc, sheet, update.serialize(), before.headers()['x-rm-revision'])
            await expect.poll(async () => (await images()).find(shape => shape.id === original.id))
                .toMatchObject({ file, src: srcFor(newBytes) })
            const renamed = (await images()).find(shape => shape.id === original.id)!
            expect(renamed.assetId).not.toBe(original.assetId)

            releaseRequest()
            await expect.poll(async () => (await images()).find(shape => shape.id === copy.id))
                .toEqual({ ...copy, src: srcFor(originalBytes) })
            expect((await images()).find(shape => shape.id === original.id)).toEqual(renamed)

            // The filename is deliberately unrelated to the native asset UUID.
            // Both moves must still target the placement after its first re-key.
            for (const expectedX of [25, 50]) {
                await page.evaluate(({ id, delta }) => {
                    const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
                    const shape = editor.getShape(id)
                    if (shape?.type !== 'image') throw new Error('Missing native image')
                    editor.updateShape({ id, type: 'image', x: shape.x + delta })
                }, { id: original.id, delta: 25 * RM_SCALE })
                await expect.poll(async () => {
                    const response = await page.request.get(endpoint + '/rm')
                    const rm = RmDocument.parse(new Uint8Array(await response.body()))
                    const photo = [...rm.tree().walk()].find(([, item]) => item.kind === 'image')?.[1]
                    return photo?.kind === 'image' ? Math.round(photo.vertices[0]!) : null
                }).toBe(expectedX)
            }

            const context = page.context()
            const url = page.url()
            await page.close()
            const reopened = await context.newPage()
            await reopened.addInitScript(([server, user]) => {
                localStorage.setItem('weft-server-url', server!)
                localStorage.setItem('weft-dev-user', user!)
                localStorage.setItem('weft-clerk-pk', '')
            }, [CLOUD_ORIGIN, E2E_USER])
            await reopened.goto(url)
            await expect.poll(() => images(reopened)).toEqual([
                { id: expect.any(String), assetId: expect.any(String), file, src: srcFor(newBytes) },
            ])
        } finally {
            releaseRequest()
        }
    })
}

for (const rename of [false, true]) {
    test(`photo history keeps the tablet's current source UUID (new filename: ${rename})`, async ({ page }) => {
        const { RmDocument, bytesToUuidLE, crdtId, lww, uuidToBytesLE } = await import('../packages/rm-format/src/index')
        const { idToOpRef } = await import('../packages/sync-engine/src/ops')
        const { doc, sheet, asset, token } = await openNativeImage(page)
        const endpoint = `/api/documents/${doc}/pages/${sheet}`
        const originalFile = asset + '.png'
        const uuid = crypto.randomUUID()
        const filename = rename ? uuid + '.png' : originalFile
        const native = async () => {
            const response = await page.request.get(endpoint + '/rm')
            const drawing = RmDocument.parse(new Uint8Array(await response.body()))
            const item = drawing.blocks.find(b => b.type === 'sceneImageItem' && !b.deletedLength && b.image)
            if (item?.type !== 'sceneImageItem' || !item.image) throw new Error('Missing photo occurrence')
            return { drawing, image: item.image, itemRef: idToOpRef(drawing, item.itemId),
                revision: response.headers()['x-rm-revision'] }
        }
        const photo = () => page.evaluate(() => {
            const editor = (window as unknown as { __weftEditor?: Editor }).__weftEditor
            const shape = editor?.getCurrentPageShapes().find(s => s.type === 'image')
            if (shape?.type !== 'image') return null
            return { id: shape.id, x: shape.x, uuid: shape.meta.weftNativeImageUuid, asset: shape.props.assetId }
        })
        await expect.poll(photo).toMatchObject({ uuid: asset })
        const initial = (await photo())!
        await page.evaluate(id => {
            const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
            editor.markHistoryStoppingPoint('move the original photo')
            editor.updateShape({ id, type: 'image', x: 20 })
        }, initial.id)
        await expect.poll(async () => (await native()).image.vertices[0]! * RM_SCALE).toBeCloseTo(20)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')

        if (rename) expect((await page.request.put(endpoint + '/assets/' + filename, {
            data: await readFile('fixtures/test-photo.png'),
        })).ok()).toBe(true)
        const before = await native()
        const registry = before.drawing.blocks.find(b => b.type === 'sceneImageInfo')
        if (registry?.type !== 'sceneImageInfo') throw new Error('Missing photo registry')
        registry.images.push({ uuid, filename: lww(crdtId(1, 72), filename), flags: lww(crdtId(1, 73), Uint8Array.of(17, 0)) })
        before.image.uuid = lww(crdtId(1, 75), uuidToBytesLE(uuid))
        await devicePut(token, doc, sheet, before.drawing.serialize(), before.revision)
        const after = await native()
        expect(after.itemRef).toEqual(before.itemRef)
        expect(bytesToUuidLE(after.image.uuid.value)).toBe(uuid)
        expect(after.image.vertices).toEqual(before.image.vertices)
        await expect.poll(photo).toMatchObject({ id: initial.id, uuid })
        const refreshed = (await photo())!
        if (rename) expect(refreshed.asset).not.toBe(initial.asset)
        else expect(refreshed.asset).toBe(initial.asset)

        await page.evaluate(() => (window as unknown as { __weftEditor: Editor }).__weftEditor.undo())
        expect(await photo()).toMatchObject({ id: initial.id, uuid, asset: refreshed.asset, x: initial.x })
        await expect.poll(async () => (await native()).image.vertices[0]! * RM_SCALE).toBeCloseTo(initial.x)
        expect(bytesToUuidLE((await native()).image.uuid.value)).toBe(uuid)
    })
}

for (const kind of ['group', 'frame'] as const) {
    test(`reparenting tablet ink and a photo into a ${kind} preserves their bytes`, async ({ page }) => {
        const { doc, sheet } = await openNativeImage(page, undefined, 1, true)
        const group = 'shape:pose-preserving-reparent' as const
        const api = `/api/documents/${doc}/pages/${sheet}`

        const placements = () => page.evaluate(() => {
            const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
            return editor?.getCurrentPageShapes().filter(shape => shape.meta.rmBrush).map(shape => {
                const { e, f } = editor.getShapePageTransform(shape)
                return { type: shape.type, x: 0 + Math.round(e), y: 0 + Math.round(f) }
            }).sort((a, b) => a.type.localeCompare(b.type))
        })
        await expect.poll(placements).toHaveLength(2)
        const before = await placements()
        const drawing = async () => {
            const response = await page.request.get(api + '/rm')
            expect(response.ok()).toBe(true)
            return response.body()
        }
        const original = await drawing()
        await page.evaluate(async ({ group, kind }) => {
            const { __weftEditor: editor, __weftController: controller } = window as unknown as {
                __weftEditor: Editor
                __weftController: { flush(): Promise<void>; session: { reconcile(): Promise<void> } }
            }
            const ids = editor!.getCurrentPageShapes().filter(shape => shape.meta.rmBrush).map(shape => shape.id)
            editor!.run(() => {
                if (kind === 'group') editor!.groupShapes(ids, { groupId: group })
                else {
                    editor!.createShape({ id: group, type: 'frame', x: -170, y: 20, rotation: 0.3 })
                    editor!.reparentShapes(ids, group)
                }
            })
            editor!.store._flushHistory()
            await controller.flush()
            await controller.session.reconcile()
        }, { group, kind })
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        expect(await placements()).toEqual(before)
        expect((await drawing()).equals(original)).toBe(true)
    })
}
