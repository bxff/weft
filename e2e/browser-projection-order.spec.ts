import { expect, test } from "@playwright/test";
import type { Editor, TLShapeId } from "tldraw";
import { RefResolver } from "../packages/sync-engine/src/refs";
import { RmDocument } from "../packages/rm-format/src/index";

for (const grouped of [false, true])
  test(`a duplicated ${grouped ? "group" : "stack"} projects in browser paint order`, async ({
    page,
    request,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("weft-server-url", location.origin);
      localStorage.setItem("weft-dev-user", "e2e");
      localStorage.setItem("weft-clerk-pk", "");
    });
    const docId = crypto.randomUUID();
    const pageId = crypto.randomUUID();
    const api = `/api/documents/${docId}/pages/${pageId}`;
    const headers = { authorization: "Bearer dev:e2e" };
    await page.goto(`/app/${docId}/${pageId}`);
    await expect(page.getByTestId("sync-status")).toHaveText("synced");
    await page.evaluate(() => {
      const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor;
      ed.createShapes([
        {
          id: "shape:below" as TLShapeId,
          type: "geo",
          x: 10,
          y: 20,
          props: { geo: "rectangle", color: "red", fill: "solid" },
        },
        {
          id: "shape:above" as TLShapeId,
          type: "geo",
          x: 20,
          y: 30,
          props: { geo: "ellipse", color: "blue", fill: "solid" },
        },
      ]);
    });
    const getOverlay = async () => {
      const response = await request.get(api + "/overlay", { headers });
      if (!response.ok()) throw Error("GET overlay failed");
      return (await response.json()) as {
        shapes: {
          shapeId: string;
          rendered: { items: { authorUuid: string; clock: number }[] }[];
        }[];
      };
    };
    await expect.poll(async () => (await getOverlay()).shapes.length).toBe(2);
    const expected = await page.evaluate((grouped) => {
      const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor;
      const originals = ["shape:below", "shape:above"] as TLShapeId[];
      if (grouped) ed.groupShapes(originals);
      ed.duplicateShapes(grouped ? [...ed.getSelectedShapeIds()] : originals, {
        x: 150,
        y: 150,
      });
      const selected = ed.getShapeAndDescendantIds([
        ...ed.getSelectedShapeIds(),
      ]);
      return ed
        .getCurrentPageShapesSorted()
        .filter((shape) => selected.has(shape.id) && shape.type !== "group")
        .map((shape) => shape.id);
    }, grouped);
    expect(expected).toHaveLength(2);
    await expect.poll(async () => (await getOverlay()).shapes.length).toBe(4);
    const visible = (await getOverlay()).shapes.filter((s) =>
      expected.includes(s.shapeId as TLShapeId),
    );
    const owned = new Map(
      visible.flatMap((s) =>
        s.rendered.flatMap((part) =>
          part.items.map(
            (i) => [`${i.authorUuid}:${i.clock}`, s.shapeId] as const,
          ),
        ),
      ),
    );
    const body = await (await request.get(api + "/rm", { headers })).body();
    const rm = RmDocument.parse(body);
    const refs = new RefResolver(rm);
    const actual: string[] = [];
    for (const [id, item] of rm.tree().walk()) {
      if (item.kind !== "line") continue;
      const ref = refs.toRef(id);
      if (!ref) continue;
      const owner = owned.get(`${ref.authorUuid}:${ref.clock}`);
      if (owner && actual.at(-1) !== owner) actual.push(owner);
    }
    expect(actual).toEqual(expected);
  });
