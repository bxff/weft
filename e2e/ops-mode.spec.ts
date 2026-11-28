/**
 * Op-mode is the sole client<->server sync path: edits ship as commutative
 * ops (server appends, no CAS/409), a fresh client reconstructs from the op
 * log, offline edits queue and push on reconnect. The device still writes
 * .rm blobs, so migration specs seed legacy pages with a device-token blob
 * PUT (see ./device-blob) and check op-mode migrates them.
 *
 * Each test uses its own dedicated blank page id, since ops append to a
 * page's log and sharing one would cross streams between tests.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { useCloudMode, CLOUD_ORIGIN, E2E_USER } from "./cloud-mode";
import {
  deviceToken,
  devicePut,
  inkRm,
  migrationPushes,
  anchoredReflowPushes,
} from "./device-blob";

useCloudMode();

const NOTEBOOK = "22222222-2222-4222-a222-222222222222";
// per-test dedicated pages (see file header)
const OPS_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab01";
const PERSIST_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab02";
const OFFLINE_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab03";
const TWOCLIENT_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab04";
const NOCAS_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab05";
const MIDSTROKE_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab13";
const REFLOW_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab14";
const INKRESIZE_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab15";

async function waitForSynced(page: Page): Promise<void> {
  await expect(page.getByTestId("sync-status")).toHaveText("synced", {
    timeout: 30_000,
  });
}

async function opsCount(page: Page, pageId: string): Promise<number> {
  const r = await page.request.get(
    `/api/documents/${NOTEBOOK}/pages/${pageId}/ops?since=0`,
  );
  const body = (await r.json()) as { ops: unknown[] };
  return body.ops.length;
}

/** opsCount via raw fetch (no browser), for asserting a device-blob page is
 *  still zero-op before an op-mode client reads it. */
async function rawOpsCount(pageId: string): Promise<number> {
  const r = await fetch(
    `${CLOUD_ORIGIN}/api/documents/${NOTEBOOK}/pages/${pageId}/ops?since=0`,
    { headers: { authorization: `Bearer dev:${E2E_USER}` } },
  );
  const body = (await r.json()) as { ops: unknown[] };
  return body.ops.length;
}

async function drawStroke(page: Page, dx = 220, dy = 220): Promise<void> {
  await page.keyboard.press("d");
  const canvas = page.locator(".tl-canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + dx, box.y + dy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + dx + i * 12, box.y + dy + Math.sin(i) * 30);
  }
  await page.mouse.up();
  await page.keyboard.press("Escape");
}

/** A fresh browser context (no IndexedDB), independent client that must
 *  rebuild from the relay. */
async function freshOpsClient(
  browser: BrowserContext["browser"],
): Promise<BrowserContext> {
  const ctx = await browser!.newContext({
    extraHTTPHeaders: { authorization: `Bearer dev:${E2E_USER}` },
  });
  await ctx.addInitScript(
    ([url, user]) => {
      localStorage.setItem("weft-server-url", url!);
      localStorage.setItem("weft-dev-user", user!);
      localStorage.setItem("weft-clerk-pk", "");
      localStorage.removeItem("weft-docs-cache");
    },
    [CLOUD_ORIGIN, E2E_USER],
  );
  return ctx;
}

test("an edit ships to the relay as ops (not a blob PUT)", async ({ page }) => {
  await page.goto(`/app/${NOTEBOOK}/${OPS_PAGE}`);
  await waitForSynced(page);
  expect(await opsCount(page, OPS_PAGE)).toBe(0);

  await drawStroke(page);

  await expect
    .poll(() => opsCount(page, OPS_PAGE), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
});

test("a fresh client reconstructs the page from the relay op log", async ({
  page,
  browser,
}) => {
  await page.goto(`/app/${NOTEBOOK}/${OPS_PAGE}`);
  await waitForSynced(page);
  await drawStroke(page);
  await expect
    .poll(() => opsCount(page, OPS_PAGE), { timeout: 15_000 })
    .toBeGreaterThan(0);

  const ctx = await freshOpsClient(browser);
  const b = await ctx.newPage();
  await b.goto(`/app/${NOTEBOOK}/${OPS_PAGE}`);
  await waitForSynced(b);
  await expect
    .poll(async () => b.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await ctx.close();
});

test("a drawn stroke persists via ops across a reload", async ({ page }) => {
  await page.goto(`/app/${NOTEBOOK}/${PERSIST_PAGE}`);
  await waitForSynced(page);
  await drawStroke(page);
  await expect
    .poll(() => opsCount(page, PERSIST_PAGE), { timeout: 15_000 })
    .toBeGreaterThan(0);
  const shapesBefore = await page.locator(".tl-shape").count();
  expect(shapesBefore).toBeGreaterThan(0);
  const opsBefore = await opsCount(page, PERSIST_PAGE);

  // reload must reconstruct the same ink idempotently, not re-append ops
  await page.reload();
  await waitForSynced(page);
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(shapesBefore);
  expect(await opsCount(page, PERSIST_PAGE)).toBe(opsBefore);
});

test("offline op edits queue locally and push on reconnect (no CAS)", async ({
  page,
}) => {
  await page.goto(`/app/${NOTEBOOK}/${OFFLINE_PAGE}`);
  await waitForSynced(page);
  expect(await opsCount(page, OFFLINE_PAGE)).toBe(0);
  const shapesBefore = await page.locator(".tl-shape").count();

  await page.route("**/api/**", (route) => route.abort("connectionfailed"));
  await drawStroke(page, 150, 150);
  await drawStroke(page, 260, 150);
  await expect(page.getByTestId("sync-status")).toContainText("offline", {
    timeout: 15_000,
  });
  // page.request bypasses page.route, so this checks the relay directly
  // without ending the outage
  expect(await opsCount(page, OFFLINE_PAGE)).toBe(0);

  // reload while offline (routes persist across navigation): ops come back
  // from IndexedDB
  await page.reload();
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(shapesBefore + 2);

  await page.unroute("**/api/**");
  await waitForSynced(page);
  await expect
    .poll(() => opsCount(page, OFFLINE_PAGE), { timeout: 30_000 })
    .toBeGreaterThan(0);
});

test("a second client sees the first client’s edits (op convergence)", async ({
  page,
  browser,
}) => {
  await page.goto(`/app/${NOTEBOOK}/${TWOCLIENT_PAGE}`);
  await waitForSynced(page);
  await drawStroke(page, 200, 200);
  await expect
    .poll(() => opsCount(page, TWOCLIENT_PAGE), { timeout: 15_000 })
    .toBeGreaterThan(0);
  const opsAfterA = await opsCount(page, TWOCLIENT_PAGE);

  const ctx = await freshOpsClient(browser);
  const b = await ctx.newPage();
  await b.goto(`/app/${NOTEBOOK}/${TWOCLIENT_PAGE}`);
  await waitForSynced(b);
  await expect
    .poll(async () => b.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBeGreaterThan(0);

  // A's own count before B draws; convergence must push A strictly past it
  const aOwn = await page.locator(".tl-shape").count();

  await drawStroke(b, 320, 300);
  await expect
    .poll(() => opsCount(b, TWOCLIENT_PAGE), { timeout: 15_000 })
    .toBeGreaterThan(opsAfterA);

  // A converges on B's edit via the live op stream (SSE -> opsSince)
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBeGreaterThan(aOwn);
  await ctx.close();
});

test("a device snapshot landing MID-STROKE never chops the stroke being drawn", async ({
  page,
}) => {
  // A stroke being drawn is neither pending (only enqueues on isComplete)
  // nor in the overlay, so a document-replaced reconcile triggered by a
  // device push must not delete it out from under the pen.
  await page.goto(`/app/${NOTEBOOK}/${MIDSTROKE_PAGE}`);
  await waitForSynced(page);
  const token = await deviceToken();

  // A begins a stroke and holds the pen down
  await page.keyboard.press("d");
  const canvas = page.locator(".tl-canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(box.x + 200 + i * 10, box.y + 200 + i * 6);
  }

  // device push while A's pen is down: fresh snapshot -> reconcile runs
  // with A's stroke still incomplete
  await devicePut(token, NOTEBOOK, MIDSTROKE_PAGE, await inkRm(1));
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);

  // A finishes the stroke: must survive the reconcile
  for (let i = 7; i <= 12; i++) {
    await page.mouse.move(box.x + 200 + i * 10, box.y + 200 + i * 6);
  }
  await page.mouse.up();
  await page.keyboard.press("Escape");

  // exactly two shapes: A's stroke (not chopped/duplicated) + the device's ink
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 15_000 })
    .toBe(2);
  await expect
    .poll(() => opsCount(page, MIDSTROKE_PAGE), { timeout: 15_000 })
    .toBeGreaterThan(0);
});

test("device text growth reflows anchored ink DOWN on the web (no reload)", async ({
  page,
}) => {
  // Anchor offsets are derived from the doc, so an existing ink/image shape
  // must shift when the device text grows above it, without a reload.
  const { first, second } = await anchoredReflowPushes();
  const token = await deviceToken();
  await devicePut(token, NOTEBOOK, REFLOW_PAGE, first);
  await page.goto(`/app/${NOTEBOOK}/${REFLOW_PAGE}`);
  await waitForSynced(page);

  const inkY = () =>
    page.evaluate(() => {
      const ed = (
        window as unknown as {
          __weftEditor?: {
            getCurrentPageShapes(): { y: number; meta?: { rmBrush?: string } }[];
          };
        }
      ).__weftEditor;
      const s = ed?.getCurrentPageShapes().find((sh) => sh.meta?.rmBrush);
      return s ? s.y : null;
    });
  await expect.poll(inkY, { timeout: 30_000 }).not.toBeNull();
  const y0 = (await inkY())!;

  // text grows by three lines: the stroke anchored to the text-end must
  // move down on the live canvas
  await devicePut(token, NOTEBOOK, REFLOW_PAGE, second);
  await expect.poll(inkY, { timeout: 30_000 }).toBeGreaterThan(y0 + 10);
});

test("resizing tablet ink grows it on canvas AND persists (transform-ink)", async ({
  page,
}) => {
  // Regression: RmDrawShapeUtil ignored tldraw 5's scaleX/scaleY, so tablet
  // ink would not resize visually, and no transform ever synced to the doc.
  const token = await deviceToken();
  await devicePut(token, NOTEBOOK, INKRESIZE_PAGE, await inkRm(1));
  await page.goto(`/app/${NOTEBOOK}/${INKRESIZE_PAGE}`);
  await waitForSynced(page);

  const inkBounds = () =>
    page.evaluate(() => {
      const ed = (
        window as unknown as {
          __weftEditor?: {
            getCurrentPageShapes(): { id: string; meta?: { rmBrush?: string } }[];
            getShapePageBounds(id: string): { w: number; h: number } | undefined;
          };
        }
      ).__weftEditor;
      const s = ed?.getCurrentPageShapes().find((sh) => sh.meta?.rmBrush);
      if (!s) return null;
      const b = ed!.getShapePageBounds(s.id);
      return b ? { w: b.w, h: b.h } : null;
    });
  await expect.poll(inkBounds, { timeout: 30_000 }).not.toBeNull();
  const before = (await inkBounds())!;

  // resize through the editor API, the same call the resize session makes
  await page.evaluate(() => {
    const ed = (
      window as unknown as {
        __weftEditor?: {
          getCurrentPageShapes(): { id: string; meta?: { rmBrush?: string } }[];
          resizeShape(id: string, scale: { x: number; y: number }): void;
        };
      }
    ).__weftEditor!;
    const s = ed.getCurrentPageShapes().find((sh) => sh.meta?.rmBrush)!;
    ed.resizeShape(s.id, { x: 2, y: 2 });
  });
  await expect
    .poll(async () => (await inkBounds())!.w, { timeout: 15_000 })
    .toBeGreaterThan(before.w * 1.5);

  // the transform bakes into the doc (ops append) and survives a reload
  await expect
    .poll(() => opsCount(page, INKRESIZE_PAGE), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await waitForSynced(page);
  await page.reload();
  await waitForSynced(page);
  await expect
    .poll(async () => (await inkBounds())?.w ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(before.w * 1.5);
});

test("the op write path never returns a CAS/409 (append is unconditional)", async ({
  page,
}) => {
  await page.goto(`/app/${NOTEBOOK}/${NOCAS_PAGE}`);
  await waitForSynced(page);

  // append twice with no base-revision handshake: the op path appends
  // unconditionally (no CAS/409)
  const post = () =>
    page.request.post(`/api/documents/${NOTEBOOK}/pages/${NOCAS_PAGE}/ops`, {
      // opaque non-ink blob: the relay only appends, never parses op bytes
      data: {
        ops: [Buffer.from('{"noop":1}').toString("base64")],
        author: null,
      },
    });
  const first = await post();
  expect(first.status()).toBe(200);
  const firstRange = (await first.json()) as {
    firstSeq: number;
    lastSeq: number;
  };
  // second append with no CAS base still succeeds and the head advances
  const second = await post();
  expect(second.status()).toBe(200);
  const secondRange = (await second.json()) as {
    firstSeq: number;
    lastSeq: number;
  };
  expect(secondRange.firstSeq).toBeGreaterThan(firstRange.lastSeq);

  const stream = await page.request.get(
    `/api/documents/${NOTEBOOK}/pages/${NOCAS_PAGE}/ops?since=0`,
  );
  expect(stream.status()).toBe(200);
  const body = (await stream.json()) as { head: number };
  expect(body.head).toBe(secondRange.lastSeq);
});

test("MIGRATION (5d): a legacy blob page opens WITH its ink in a default op-mode browser", async ({
  browser,
}) => {
  const MIGRATE_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab07";
  // device-token blob PUT simulates a legacy pre-op-mode page: ink in the
  // blob store, zero ops
  const token = await deviceToken();
  await devicePut(token, NOTEBOOK, MIGRATE_PAGE, await inkRm(1));
  expect(
    (
      await fetch(
        `${CLOUD_ORIGIN}/api/documents/${NOTEBOOK}/pages/${MIGRATE_PAGE}/rm`,
        { headers: { authorization: `Bearer dev:${E2E_USER}` } },
      )
    ).status,
  ).toBe(200);
  expect(await rawOpsCount(MIGRATE_PAGE)).toBe(0);

  // a default op-mode browser opens the same page: the server must seed the
  // blob as the base snapshot so legacy ink renders (not a blank page)
  const opCtx = await freshOpsClient(browser);
  const opPage = await opCtx.newPage();
  await opPage.goto(`/app/${NOTEBOOK}/${MIGRATE_PAGE}`);
  await waitForSynced(opPage);
  await expect
    .poll(async () => opPage.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBeGreaterThan(0);

  // drawing on top must add to the blob content, not replace it
  const before = await opPage.locator(".tl-shape").count();
  await drawStroke(opPage, 400, 400);
  await expect
    .poll(async () => opsCount(opPage, MIGRATE_PAGE), { timeout: 15_000 })
    .toBeGreaterThan(0);
  const rm = await opPage.request.get(
    `/api/documents/${NOTEBOOK}/pages/${MIGRATE_PAGE}/rm`,
  );
  expect(rm.status()).toBe(200);

  // reload: reconstruct = seeded blob + ops, both strokes still there
  await opPage.reload();
  await waitForSynced(opPage);
  await expect
    .poll(async () => opPage.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBeGreaterThan(before);
  await opCtx.close();
});

test("HISTORY UI: timeline lists edits; panel restore reverts and un-reverts", async ({
  page,
}) => {
  const HIST_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab08";
  await page.goto(`/app/${NOTEBOOK}/${HIST_PAGE}`);
  await waitForSynced(page);

  // page_ops.seq is a store-wide autoincrement, not per-page, so this
  // captures the stroke's real last-op seq rather than assuming 1..N
  await drawStroke(page, 150, 150);
  await expect
    .poll(() => opsCount(page, HIST_PAGE), { timeout: 15_000 })
    .toBeGreaterThan(0);
  const countAfterFirst = await opsCount(page, HIST_PAGE);
  const firstStrokeSeq = await (async () => {
    const r = await page.request.get(
      `/api/documents/${NOTEBOOK}/pages/${HIST_PAGE}/ops?since=0`,
    );
    const body = (await r.json()) as { ops: { seq: number }[] };
    return body.ops[body.ops.length - 1]!.seq;
  })();
  const shapesOne = await page.locator(".tl-shape").count();

  await drawStroke(page, 420, 420);
  await expect
    .poll(() => opsCount(page, HIST_PAGE), { timeout: 15_000 })
    .toBeGreaterThan(countAfterFirst);
  const shapesTwo = await page.locator(".tl-shape").count();
  expect(shapesTwo).toBeGreaterThan(shapesOne);

  // revert to the end of stroke 1: canvas drops back to one stroke
  const revert = await page.request.post(
    `/api/documents/${NOTEBOOK}/pages/${HIST_PAGE}/revert`,
    { data: { toSeq: firstStrokeSeq } },
  );
  expect(revert.status()).toBe(200);
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBe(shapesOne);

  await page.getByTestId("history-toggle").click();
  await expect(page.getByTestId("history-panel")).toBeVisible();
  await expect
    .poll(async () => page.getByTestId("history-row").count(), {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("history-panel")).toContainText("restored");

  // restoring the newest row through the UI un-reverts, bringing stroke 2 back
  const restoreButtons = page.locator('[data-restore]'); // whole row restores
  await expect
    .poll(async () => restoreButtons.count(), { timeout: 10_000 })
    .toBeGreaterThan(0);
  await restoreButtons.first().click();
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBe(shapesTwo);
});

test("HISTORY UI: CHECKPOINT rows are restorable (migrated page = checkpoints-only timeline)", async ({
  browser,
}) => {
  // A page migrated from the blob era has a timeline whose oldest point is
  // a seeded checkpoint (op seq 0); its restore button must render too, not
  // just on 'edits' runs.
  const CKPT_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab09";

  const token = await deviceToken();
  await devicePut(token, NOTEBOOK, CKPT_PAGE, await inkRm(1));
  expect(
    (
      await fetch(
        `${CLOUD_ORIGIN}/api/documents/${NOTEBOOK}/pages/${CKPT_PAGE}/rm`,
        { headers: { authorization: `Bearer dev:${E2E_USER}` } },
      )
    ).status,
  ).toBe(200);
  expect(await rawOpsCount(CKPT_PAGE)).toBe(0);

  // lazy migration seeds the blob as a checkpoint at op seq 0; edit on top
  const ctx = await freshOpsClient(browser);
  const page = await ctx.newPage();
  await page.goto(`/app/${NOTEBOOK}/${CKPT_PAGE}`);
  await waitForSynced(page);
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  const shapesAtCheckpoint = await page.locator(".tl-shape").count();
  await drawStroke(page, 430, 430);
  await expect
    .poll(() => opsCount(page, CKPT_PAGE), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 15_000 })
    .toBeGreaterThan(shapesAtCheckpoint);

  // the checkpoint row must show with a restore button (whole row is the
  // control; checkpoints restore by snapshot seq)
  await page.getByTestId("history-toggle").click();
  await expect(page.getByTestId("history-panel")).toBeVisible();
  await expect(page.getByTestId("history-panel")).toContainText("checkpoint", {
    timeout: 15_000,
  });
  // authorship must say 'browser', never a raw engine UUID
  await expect(page.getByTestId("history-panel")).toContainText("browser");
  await expect(page.getByTestId("history-panel")).not.toContainText(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  );
  const checkpointRestore = page
    .locator('[data-restore^="snap-"]')
    .last();
  await expect(checkpointRestore).toBeVisible({ timeout: 10_000 });

  await checkpointRestore.click();
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBe(shapesAtCheckpoint);
  await expect(page.getByTestId("history-panel")).toContainText("restored", {
    timeout: 15_000,
  });
  await ctx.close();
});

test("HISTORY UI: a tablet-only page (zero ops, N snapshots) can restore an older push", async ({
  browser,
}) => {
  // A page only ever written from the tablet folds a snapshot at op seq 0 on
  // every push, so op seqs alone can't distinguish states: restore must
  // address the snapshot itself.
  const TABLET_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab10";
  const DEV_AUTH = { authorization: `Bearer dev:${E2E_USER}` };
  const token = await deviceToken();
  // `first` is one stroke; `second` carries the same stroke plus a typed
  // text column, sharing the stroke id so push 2 emits zero ops (line diff
  // carries it through) while the new root text folds a fresh checkpoint.
  const { first, second } = await migrationPushes();

  await devicePut(token, NOTEBOOK, TABLET_PAGE, first);

  const seeded = await fetch(
    `${CLOUD_ORIGIN}/api/documents/${NOTEBOOK}/pages/${TABLET_PAGE}/history`,
    { headers: DEV_AUTH },
  );
  expect(seeded.ok).toBe(true);

  await devicePut(token, NOTEBOOK, TABLET_PAGE, second);
  await expect
    .poll(
      async () => {
        const r = await fetch(
          `${CLOUD_ORIGIN}/api/documents/${NOTEBOOK}/pages/${TABLET_PAGE}/history`,
          { headers: DEV_AUTH },
        );
        const body = (await r.json()) as { points: { kind: string }[] };
        return body.points.filter((p) => p.kind === "snapshot").length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(2);
  expect(await rawOpsCount(TABLET_PAGE)).toBe(0);

  // current state = stroke + text column = two shapes; checkpoint #1 (the
  // older push) is the stroke alone, so restoring it must drop below this
  const shapesAfterBoth = 2;

  const ctx = await freshOpsClient(browser);
  const page = await ctx.newPage();
  await page.goto(`/app/${NOTEBOOK}/${TABLET_PAGE}`);
  await waitForSynced(page);
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBe(shapesAfterBoth);
  expect(await opsCount(page, TABLET_PAGE)).toBe(0);

  await page.getByTestId("history-toggle").click();
  await expect(page.getByTestId("history-panel")).toBeVisible();
  const restoreButtons = page.locator('[data-restore^="snap-"]');
  // older pushes are restorable; the newest checkpoint (current state) is not
  await expect
    .poll(async () => restoreButtons.count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  const rowCount = await page.getByTestId("history-row").count();
  expect(await restoreButtons.count()).toBe(rowCount - 1);

  // restore the oldest push (last row): back to one stroke's shapes
  await restoreButtons.last().click();
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 30_000 })
    .toBeLessThan(shapesAfterBoth);
  await expect(page.getByTestId("history-panel")).toContainText("restored", {
    timeout: 15_000,
  });
  await ctx.close();
});

test("DEVICE TEXT: native shape editing creates and edits the text column", async ({
  page,
}) => {
  const TEXT_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab11";
  await page.goto(`/app/${NOTEBOOK}/${TEXT_PAGE}`);
  await waitForSynced(page);

  // 'Edit device text' action creates the column and drops into editing
  await page.evaluate(() =>
    (
      window as unknown as {
        __weftController: { editRootText(e: object): Promise<void> };
      }
    ).__weftController.editRootText({ create: {} }),
  );
  const column = page.locator('.tl-shape[data-shape-type="device-text"]');
  await expect(column).toBeVisible();

  // an empty column sits over ink and must not swallow canvas clicks
  await page.keyboard.press("v");
  const emptyBox = (await column.boundingBox())!;
  await page.mouse.click(emptyBox.x + emptyBox.width / 2, emptyBox.y + 12);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __weftEditor: { getSelectedShapeIds(): string[] } })
          .__weftEditor.getSelectedShapeIds(),
    ),
  ).not.toContain("shape:device-text");
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    (
      window as unknown as {
        __weftEditor: { setEditingShape(id: string): void };
      }
    ).__weftEditor.setEditingShape("shape:device-text");
  });
  await expect(column.locator(".ProseMirror")).toBeVisible();
  await page.keyboard.type("Hello device");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second line");
  // clicking far-away empty canvas commits the edit (onEditEnd)
  await page.mouse.click(emptyBox.x + 700, emptyBox.y + 500);
  await expect(column).toContainText("Hello device", { timeout: 15_000 });
  await waitForSynced(page);

  await page.reload();
  await waitForSynced(page);
  const col2 = page.locator('.tl-shape[data-shape-type="device-text"]');
  await expect(col2).toContainText("Second line", { timeout: 30_000 });

  const { RmDocument, linearizeRootText } = await import("../packages/rm-format/src/index");
  const rm = await page.request.get(`/api/documents/${NOTEBOOK}/pages/${TEXT_PAGE}/rm`);
  expect(rm.status()).toBe(200);
  const doc = RmDocument.parse(new Uint8Array(await rm.body()) as never);
  const text = linearizeRootText(doc.tree().rootText!)
    .map((p) => p.spans.map((s) => s.text).join(""))
    .join("\n");
  expect(text).toBe("Hello device\nSecond line");

  // with text present the shape is clickable on its text; the static view
  // renders as SVG (not HTMLContainer) so it can't pixel-drift against ink
  await page.keyboard.press("v");
  const staticText = col2.locator("svg text").first();
  const staticBox = (await staticText.boundingBox())!;
  await page.mouse.click(staticBox.x + 10, staticBox.y + staticBox.height / 2);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __weftEditor: { getSelectedShapeIds(): string[] } })
          .__weftEditor.getSelectedShapeIds(),
    ),
  ).toEqual(["shape:device-text"]);

  // entering edit mode must not shift the text: compare the first glyph's
  // baseline pen origin between the static SVG (exact, via screen CTM) and
  // the editor (Range rect top + measured font ascent = baseline)
  const staticPen = await page.evaluate(() => {
    const t = document.querySelector(
      '.tl-shape[data-shape-type="device-text"] svg text',
    ) as SVGTextElement;
    const x = parseFloat((t.getAttribute("x") ?? "0").split(/\s+/)[0]!);
    const y = parseFloat(t.getAttribute("y") ?? "0");
    const pt = new DOMPoint(x, y).matrixTransform(t.getScreenCTM()!);
    return { x: pt.x, y: pt.y };
  });
  await page.keyboard.press("Enter");
  const editingPara = col2.locator(".ProseMirror p").first();
  await expect(editingPara).toBeVisible();
  const editPen = await page.evaluate(() => {
    const p = document.querySelector(
      '.tl-shape[data-shape-type="device-text"] .ProseMirror p',
    )!;
    const textNode = (function find(n: Node): Text | null {
      if (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) return n as Text;
      for (const c of n.childNodes) {
        const hit = find(c);
        if (hit) return hit;
      }
      return null;
    })(p)!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 1);
    const rect = range.getBoundingClientRect();
    const style = getComputedStyle(p);
    const canvas = document.createElement("canvas").getContext("2d")!;
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    // rect is screen space but computed fontSize is untransformed page px:
    // scale the ascent by camera zoom or the estimate drifts
    const zoom =
      (window as unknown as { __weftEditor?: { getZoomLevel(): number } }).__weftEditor?.getZoomLevel() ?? 1;
    const ascent = canvas.measureText("H").fontBoundingBoxAscent * zoom;
    return { x: rect.left, y: rect.top + ascent };
  });
  expect(Math.abs(editPen.x - staticPen.x)).toBeLessThan(1.5);
  // canvas and layout ascents disagree by ~1-2px for the same font; 3px
  // still catches a real regression (past shifts were 5-20px)
  expect(Math.abs(editPen.y - staticPen.y)).toBeLessThan(3);

  // edit entry selects all; collapse to the end before appending
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" EDITED");
  await page.mouse.click(staticBox.x + 700, staticBox.y + 500);
  await expect(col2).toContainText("Second line EDITED", { timeout: 15_000 });
  await page.screenshot({ path: "e2e/artifacts/device-text.png" });
});

test("DEVICE TEXT: toolbar is limited to rm features and bold persists to the device bytes", async ({
  page,
}) => {
  const TEXT_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab12";
  await page.goto(`/app/${NOTEBOOK}/${TEXT_PAGE}`);
  await waitForSynced(page);

  await page.evaluate(() =>
    (
      window as unknown as {
        __weftController: { editRootText(e: object): Promise<void> };
      }
    ).__weftController.editRootText({ create: {} }),
  );
  await page.keyboard.press("v");
  const column = page.locator('.tl-shape[data-shape-type="device-text"]');
  await page.evaluate(() => {
    (
      window as unknown as {
        __weftEditor: { setEditingShape(id: string): void };
      }
    ).__weftEditor.setEditingShape("shape:device-text");
  });
  await expect(column.locator(".ProseMirror")).toBeVisible();
  await page.keyboard.type("make this heavy");
  // select the word "heavy" to trigger the contextual toolbar
  for (let i = 0; i < "heavy".length; i++) {
    await page.keyboard.press("Shift+ArrowLeft");
  }
  await expect(page.getByTestId("rich-text.bold")).toBeVisible({ timeout: 10_000 });
  // only rm-expressible controls: 4 heading sizes, both list kinds, bold, italic
  await expect(page.getByTestId("rich-text.heading1")).toBeVisible();
  await expect(page.getByTestId("rich-text.heading2")).toBeVisible();
  await expect(page.getByTestId("rich-text.heading3")).toBeVisible();
  await expect(page.getByTestId("rich-text.bulletList")).toBeVisible();
  await expect(page.getByTestId("rich-text.orderedList")).toBeVisible();
  await expect(page.getByTestId("rich-text.italic")).toBeVisible();
  await expect(page.getByTestId("rich-text.code")).toHaveCount(0);
  await expect(page.getByTestId("rich-text.link")).toHaveCount(0);
  await expect(page.getByTestId("rich-text.strike")).toHaveCount(0);
  await expect(page.getByTestId("rich-text.highlight")).toHaveCount(0);

  // toggle via the same TipTap command the button runs, with an explicit
  // PM range so the check can't race DOM selection
  await page.evaluate(() => {
    const te = (
      window as unknown as {
        __weftEditor: { getRichTextEditor(): unknown };
      }
    ).__weftEditor.getRichTextEditor() as {
      chain(): {
        focus(): {
          setTextSelection(r: { from: number; to: number }): {
            toggleBold(): { run(): void };
          };
        };
      };
    };
    te.chain().focus().setTextSelection({ from: 11, to: 16 }).toggleBold().run();
  });
  await expect(column.locator("strong").first()).toContainText("heavy");
  const box = (await column.boundingBox())!;
  await page.mouse.click(box.x + 700, box.y + 500);
  await waitForSynced(page);

  const { RmDocument, linearizeRootText } = await import("../packages/rm-format/src/index");
  const rm = await page.request.get(`/api/documents/${NOTEBOOK}/pages/${TEXT_PAGE}/rm`);
  expect(rm.status()).toBe(200);
  const doc = RmDocument.parse(new Uint8Array(await rm.body()) as never);
  const spans = linearizeRootText(doc.tree().rootText!)[0]!.spans.map((s) => ({
    text: s.text,
    bold: s.bold,
  }));
  expect(spans).toEqual([
    { text: "make this ", bold: false },
    { text: "heavy", bold: true },
  ]);
});

async function drawState(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __weftEditor: { getCurrentPageShapes(): { type: string; props: { isComplete?: boolean } }[] };
      __weftController: { session: { pendingCount: number } }
    };
    if (!w.__weftEditor || !w.__weftController?.session) return {complete: -1, incomplete: -1, ops: -1};
    const draws = w.__weftEditor.getCurrentPageShapes().filter(s => s.type === "draw");
    return {
      complete: draws.filter(s => s.props.isComplete).length,
      incomplete: draws.filter(s => !s.props.isComplete).length,
      ops: w.__weftController.session.pendingCount,
    };
  });
}

test("a finished offline stroke is staged before the relay debounce and survives immediate reload", async ({ page }) => {
  const id = crypto.randomUUID();
  await page.goto(`/app/${NOTEBOOK}/${id}`);
  await waitForSynced(page);
  await page.route("**/api/**", route => route.abort("connectionfailed"));
  await drawStroke(page, 150, 150);
  await expect(page.getByTestId("sync-status")).toHaveText("offline");
  await drawStroke(page, 260, 150);
  await expect.poll(async () => (await drawState(page)).ops).toBe(2);
  await expect(page.getByTestId("sync-status")).not.toHaveText("saving locally…");
  await page.reload();
  await expect.poll(async () => (await drawState(page)).complete).toBe(2);
  await page.reload();
  await expect.poll(async () => (await drawState(page)).complete).toBe(2);
  expect(await opsCount(page, id)).toBe(0);
  await page.unroute("**/api/**");
  await waitForSynced(page);
  // Each stroke produces one native add and one semantic overlay upsert.
  await expect.poll(() => opsCount(page,id)).toBe(4);
  const { RmDocument } = await import('../packages/rm-format/src/index');
  const bytes = await (await page.request.get(`/api/documents/${NOTEBOOK}/pages/${id}/rm`)).body();
  const doc = RmDocument.parse(new Uint8Array(bytes));
  expect([...doc.tree().walk()].filter(([, item]) => item.kind === 'line')).toHaveLength(2);
  await page.reload();
  await waitForSynced(page);
  expect(await drawState(page)).toMatchObject({complete:2, ops:0});
});

for (const reject of [false, true]) {
  test(`local storage gate controls completed stroke status (reject=${reject})`, async ({page}) => {
    const id = crypto.randomUUID();
    await page.goto(`/app/${NOTEBOOK}/${id}`);
    await waitForSynced(page);
    await page.route("**/api/**", route => route.abort("connectionfailed"));
    await page.evaluate((reject) => {
      type State = Window & { finishPenWrite: () => void; penWriteEntered: boolean; __weftController: { session: { storage: { set(key: string, bytes: Uint8Array): Promise<void> }; savePending(): Promise<void> } } };
      const w = window as unknown as State;
      const storage = w.__weftController.session.storage;
      const set = storage.set.bind(storage);
      const gate = new Promise<void>(resolve => { w.finishPenWrite = resolve });
      storage.set = async (key, bytes) => {
        if (key.includes('/pending/') && !w.penWriteEntered) {
          w.penWriteEntered = true;
          await gate;
          if (reject) throw new DOMException('Synthetic write rejected', 'QuotaExceededError');
        }
        await set(key, bytes);
      };
    }, reject);
    await drawStroke(page, 145, 140);
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "penWriteEntered"))).toBe(true);
    await expect(page.getByTestId("sync-status")).toHaveText("saving locally…");
    await page.evaluate(() => Reflect.get(window, "finishPenWrite")());
    if (reject) {
      await expect(page.getByTestId("sync-status")).toHaveText("sync problem");
      await page.evaluate(() => Reflect.get(window, "__weftController").session.reconcile());
      await expect(page.getByTestId("sync-status")).toHaveText("sync problem");
      // Another stroke commits the whole pending queue, including the first.
      // Staying in the editor must then show offline (not a permanent error).
      await drawStroke(page, 280, 140);
    }
    await expect(page.getByTestId("sync-status")).toHaveText("offline");
    await page.reload();
    await expect.poll(async () => (await drawState(page)).complete).toBe(reject ? 2 : 1);
  });
}


test("an interrupted in-progress pen mark is not journaled", async ({page}) => {
  const id=crypto.randomUUID();
  await page.goto(`/app/${NOTEBOOK}/${id}`);
  await waitForSynced(page);
  await page.route("**/api/**", route => route.abort("connectionfailed"));
  await page.keyboard.press("d");
  const box=(await page.locator(".tl-canvas").boundingBox())!;
  await page.mouse.move(box.x+150,box.y+150);
  await page.mouse.down();
  await page.mouse.move(box.x+260,box.y+170,{steps:6});
  await expect.poll(async () => (await drawState(page)).incomplete).toBe(1);
  expect((await drawState(page)).ops).toBe(0);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.reload();
  await expect(page.getByTestId("sync-status")).toHaveText("offline");
  expect(await drawState(page)).toEqual({ complete:0,incomplete:0,ops:0 });
});

test("split pen gestures finish as one undoable gesture", async ({page}) => {
  const id=crypto.randomUUID();
  await page.goto(`/app/${NOTEBOOK}/${id}`);
  await waitForSynced(page);
  await page.route("**/api/**", route => route.abort("connectionfailed"));
  await page.evaluate(() => {
    const ed=Reflect.get(window,'__weftEditor');
    ed.getShapeUtil('draw').options.maxPointsPerShape = 8;
  });
  await page.keyboard.press("d");
  const box=(await page.locator(".tl-canvas").boundingBox())!;
  await page.mouse.move(box.x+145,box.y+176);
  await page.mouse.down();
  await page.mouse.move(box.x+465,box.y+198,{steps:25});
  const middle=await drawState(page);
  expect(middle.complete).toBeGreaterThan(0);
  expect(middle.incomplete).toBe(1);
  await page.mouse.up();
  await expect.poll(async () => (await drawState(page)).incomplete).toBe(0);
  await expect(page.getByTestId("sync-status")).toHaveText("offline");
  const beforeUndo=await drawState(page);
  expect(beforeUndo.complete).toBe(middle.complete+1);
  expect(beforeUndo.ops).toBe(beforeUndo.complete);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await drawState(page)).complete).toBe(0);
  await expect.poll(async () => (await drawState(page)).ops).toBe(beforeUndo.ops*2);
  await expect(page.getByTestId("sync-status")).toHaveText("offline");
  await page.reload();
  await expect(page.getByTestId("sync-status")).toHaveText("offline");
  expect((await drawState(page)).complete).toBe(0);
});


test("an older write must not report a completed stroke saved while mixed work is still queued", async ({page}) => {
  const id=crypto.randomUUID();
  await page.goto(`/app/${NOTEBOOK}/${id}`);
  await waitForSynced(page);
  await page.route("**/api/**", route => route.abort("connectionfailed"));
  await page.evaluate(() => {
    const w = window as Window & {setPenGate?: () => void; penGateEntered?: boolean};
    const storage = Reflect.get(window, "__weftController").session.storage;
    const set = storage.set.bind(storage);
    const gate = new Promise<void>(resolve => {w.setPenGate = resolve;});
    storage.set = async (key: string, bytes: Uint8Array) => {
      if (key.includes('/pending/') && !w.penGateEntered) {
        w.penGateEntered = true;
        await gate;
      }
      return set(key, bytes);
    };
  });
  await drawStroke(page, 145, 140);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "penGateEntered"))).toBe(true);
  await drawStroke(page, 225, 245);
  await page.evaluate(() => {
    const e=Reflect.get(window,"__weftEditor");
    e.createShape({ type: "geo", x: 70, y: 45, props: {geo:"rectangle", w:60, h:80} });
    e.store._flushHistory();
    const t=setTimeout;
    const blocked: Array<() => void> = [];
    window.setTimeout = ((fn:TimerHandler,delay?:number,...args:unknown[]) => {
      if (delay === 180 && typeof fn === 'function') {
        return t(() => blocked.push(() => fn(...args)), 0);
      }
      return t(fn,delay,...args);
    }) as typeof window.setTimeout;
    Reflect.set(window, "resumePenDebounce", () => {
      window.setTimeout = t;
      for (const fn of blocked.splice(0)) fn();
    });
  });
  await expect(page.getByTestId("sync-status")).toHaveText("saving locally…");
  await page.evaluate(async () => {
    const c=Reflect.get(window,"__weftController");
    const older=c.flushing;
    Reflect.get(window,"setPenGate")();
    await older;
    // Let the deferred fast-path continuation recheck the mixed batch.
    await new Promise<void>(resolve=>setTimeout(resolve,0));
  });
  expect((await drawState(page)).ops).toBe(1);
  expect((await drawState(page)).complete).toBe(2);
  await expect(page.getByTestId("sync-status")).toHaveText("saving locally…");
  await page.evaluate(() => Reflect.get(window, "resumePenDebounce")());
  await expect(page.getByTestId("sync-status")).toHaveText("offline");
  await page.reload();
  await expect.poll(async () => (await drawState(page)).complete).toBe(2);
  await expect(page.locator('.tl-shape[data-shape-type="geo"]')).toHaveCount(1);
});
