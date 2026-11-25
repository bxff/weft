/**
 * A stroke pushed from the tablet must render into tldraw shapes on an
 * already-open web page, live, without reload.
 */

import { test, expect } from "@playwright/test";
import { useCloudMode } from "./cloud-mode";
import { deviceToken, devicePut } from "./device-blob";

useCloudMode();

const NOTEBOOK = "22222222-2222-4222-a222-222222222222";
const PAGE = "a0b1c2d3-0000-4000-a000-00000000ab88";
const DEVICE_AUTHOR = "f73f497f-0000-4000-a000-000000000000";

async function pageWith(strokes: number): Promise<Uint8Array> {
  const { RmDocument, Pen, PenColor } = await import("../packages/rm-format/src/index");
  const doc = RmDocument.empty(DEVICE_AUTHOR);
  for (let i = 0; i < strokes; i++) {
    doc.appendLine(
      {
        kind: "line", tool: Pen.BALLPOINT_2, color: PenColor.BLACK,
        thicknessScale: 2, startingLength: 0,
        timestamp: { part1: 0, part2: 1 }, moveId: null,
        points: [
          { x: 100 + i * 50, y: 100, speed: 4, direction: 0, width: 20, pressure: 128 },
          { x: 100 + i * 50, y: 300, speed: 4, direction: 0, width: 20, pressure: 128 },
        ],
      },
      { authorUuid: DEVICE_AUTHOR },
    );
  }
  doc.normalizeLayout();
  return doc.serialize();
}

test("a tablet stroke pushed while the page is OPEN renders live, no reload", async ({ page }) => {
  const token = await deviceToken();
  await devicePut(token, NOTEBOOK, PAGE, await pageWith(1), "");
  await page.goto(`/app/${NOTEBOOK}/${PAGE}`);
  await expect(page.getByTestId("sync-status")).toHaveText("synced", { timeout: 30_000 });
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 20_000 })
    .toBe(1);

  // device pushes a second stroke while the page stays open: GET current, edit, PUT with base revision
  const r = await fetch(
    `http://localhost:${process.env.WEFT_E2E_CLOUD_PORT ?? ""}`,
  ).catch(() => null);
  void r;
  const { CLOUD_ORIGIN } = await import("./cloud-mode");
  const cur = await fetch(`${CLOUD_ORIGIN}/api/documents/${NOTEBOOK}/pages/${PAGE}/rm`, {
    headers: { "x-device-token": token },
  });
  const baseRev = cur.headers.get("x-rm-revision") ?? "";
  await devicePut(token, NOTEBOOK, PAGE, await pageWith(2), baseRev);

  try {
    await expect
      .poll(async () => page.locator(".tl-shape").count(), { timeout: 25_000 })
      .toBe(2);
  } catch (e) {
    // diagnose engine state vs controller render
    const diag = await page.evaluate(async () => {
      const c = (window as never as { __weftController?: { session?: unknown } }).__weftController as {
        session?: {
          document: { blocks: { type: string; deletedLength?: number }[] };
          pendingCount: number;
          reconcile(): Promise<void>;
        };
      };
      if (!c?.session) return { err: "no controller/session" };
      const count = () =>
        c.session!.document.blocks.filter(
          (b) => b.type === "sceneLineItem" && (b as { deletedLength: number }).deletedLength === 0,
        ).length;
      const before = count();
      const shapesBefore = document.querySelectorAll(".tl-shape").length;
      await c.session.reconcile();
      await new Promise((r) => setTimeout(r, 500));
      return {
        engineBefore: before,
        engineAfter: count(),
        shapesBefore,
        shapesAfter: document.querySelectorAll(".tl-shape").length,
        pending: c.session.pendingCount,
      };
    });
    console.log("DIAG:", JSON.stringify(diag));
    const ops = await fetch(
      `${(await import("./cloud-mode")).CLOUD_ORIGIN}/api/documents/${NOTEBOOK}/pages/${PAGE}/ops?since=0`,
      { headers: { authorization: `Bearer dev:${(await import("./cloud-mode")).E2E_USER}` } },
    ).then((r) => r.json() as Promise<{ ops: unknown[] }>);
    console.log("DIAG cloud ops:", ops.ops.length);
    throw e;
  }
});
