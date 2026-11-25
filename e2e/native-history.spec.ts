import { expect, test, type Page } from "@playwright/test";
import type { Editor, TLShapeId } from "tldraw";
import { RmDocument } from "../packages/rm-format/src";
import { RM_SCALE } from "../packages/rm-ink/src/pen";
import { encodeSnapshot } from "../packages/sync-engine/src/snapshot";
import { useCloudMode } from "./cloud-mode";
import { devicePut, deviceToken, inkRm } from "./device-blob";

useCloudMode();

async function flushEdits(page: Page) {
  await page.evaluate(async () => {
    const { __weftEditor: editor, __weftController: controller } =
      window as unknown as {
        __weftEditor: Editor;
        __weftController: { flush(): Promise<void> };
      };
    editor.store._flushHistory();
    await controller.flush();
  });
  await expect(page.getByTestId("sync-status")).toHaveText("synced");
}

test("stale native history preserves tablet geometry and fresh changes still undo", async ({
  page,
}) => {
  const doc = "11111111-1111-4111-a111-111111111111";
  const sheet = crypto.randomUUID();
  const token = await deviceToken();
  const path = `/api/documents/${doc}/pages/${sheet}`;
  await devicePut(token, doc, sheet, await inkRm(1));
  await page.goto(`/app/${doc}/${sheet}`);
  await expect(page.getByTestId("sync-status")).toHaveText("synced");
  const draw = () =>
    page.evaluate(() => {
      const editor = (window as unknown as { __weftEditor?: Editor })
        .__weftEditor;
      const shape = editor
        ?.getCurrentPageShapes()
        .find((s) => s.type === "draw");
      return (
        shape && {
          id: shape.id,
          x: shape.x,
          locked: shape.isLocked,
          selected: editor?.getSelectedShapeIds(),
        }
      );
    });
  await expect.poll(() => draw()).toBeDefined();
  const stroke = (await draw())!;
  const read = async () => {
    const result = await page.request.get(path + "/rm");
    return RmDocument.parse(new Uint8Array(await result.body()));
  };
  const native = (rm: RmDocument) =>
    [...rm.tree().walk()].flatMap(([, item]) =>
      item.kind === "line" ? [item] : [],
    )[0];
  const nativeGeometry = async () => {
    const points = native(await read())?.points;
    return points?.map((p) => [Math.round(p.x), Math.round(p.y)]);
  };
  const initial = (await nativeGeometry())!;
  await page.evaluate(
    ({ id, delta }) => {
      const { __weftEditor: editor } = window as unknown as {
        __weftEditor: Editor;
      };
      editor.select(id);
      editor.markHistoryStoppingPoint("native move before tablet refresh");
      const shape = editor.getShape(id)!;
      editor.updateShape({
        id,
        type: "draw",
        x: shape.x + delta,
        isLocked: true,
      });
    },
    { id: stroke.id, delta: 32 * RM_SCALE },
  );
  await expect
    .poll(async () => (await nativeGeometry())?.[0]?.[0])
    .toBe(initial[0]![0]! + 32);
  await expect(page.getByTestId("sync-status")).toHaveText("synced");

  const update = await read();
  const current = native(update)!;
  for (const [i, point] of current.points.entries()) {
    point.x += 150;
    point.y += i * 20;
  }
  const remote = current.points.map((p) => [Math.round(p.x), Math.round(p.y)]);
  expect(
    (
      await page.request.put(path + "/snapshot", {
        data: Buffer.from(encodeSnapshot(update.serialize(), { shapes: [] })),
      })
    ).ok(),
  ).toBe(true);
  await expect.poll(nativeGeometry).toEqual(remote);
  await expect(page.getByTestId("sync-status")).toHaveText("synced");
  const sessionToken = (await page.request.get(path + "/rm")).headers()[
    "x-rm-revision"
  ];
  await expect
    .poll(async () => Math.round((await draw())!.x / RM_SCALE))
    .toBe(remote[0]![0]);
  const beforeUndo = await draw();
  expect(beforeUndo!.locked).toBe(true);

  await page.evaluate(() => {
    const { __weftEditor: editor } = window as unknown as {
      __weftEditor: Editor;
    };
    editor.markHistoryStoppingPoint("unrelated browser shape");
    editor.createShape({
      id: "shape:test-undo-unrelated" as TLShapeId,
      type: "geo",
      x: 20,
      y: 80,
    });
    editor.undo();
  });
  await flushEdits(page);
  expect(await nativeGeometry()).toEqual(remote);
  const unrelatedRevision = (await page.request.get(path + "/rm")).headers()[
    "x-rm-revision"
  ];
  expect(unrelatedRevision).toBe(sessionToken);
  expect((await draw())!.locked).toBe(true);

  await page.evaluate(() => {
    const { __weftEditor: editor } = window as unknown as {
      __weftEditor: Editor;
    };
    editor.undo();
  });
  await expect.poll(async () => (await draw())!.locked).toBe(false);
  await flushEdits(page);
  const afterStaleUndo = await draw();
  expect(Math.round(afterStaleUndo!.x / RM_SCALE)).toBe(remote[0]![0]);
  expect(await nativeGeometry()).toEqual(remote);
  expect(
    (await page.request.get(path + "/rm")).headers()["x-rm-revision"],
  ).toBe(unrelatedRevision);

  await page.evaluate(
    ({ id, delta }) => {
      const editor = (window as unknown as { __weftEditor: Editor })
        .__weftEditor;
      editor.markHistoryStoppingPoint("fresh native move");
      editor.updateShape({
        id,
        type: "draw",
        x: editor.getShape(id)!.x + delta,
      });
    },
    { id: stroke.id, delta: 40 * RM_SCALE },
  );
  await expect
    .poll(nativeGeometry)
    .toEqual(remote.map(([x, y]) => [x! + 40, y]));
  await expect(page.getByTestId("sync-status")).toHaveText("synced");
  await page.evaluate(() => {
    (window as unknown as { __weftEditor: Editor }).__weftEditor.undo();
  });
  await expect.poll(nativeGeometry).toEqual(remote);
});
