/**
 * Two tabs in the same browser context (shared IndexedDB + Web Locks, separate
 * sessionStorage) edit the same page concurrently: must mint distinct CRDT
 * authors, converge to the union, no duplicated strokes.
 */

import { test, expect, type Page } from "@playwright/test";
import { useCloudMode } from "./cloud-mode";

useCloudMode();

const NOTEBOOK = "22222222-2222-4222-a222-222222222222";
const TABS_PAGE = "a0b1c2d3-0000-4000-a000-00000000ab99";

async function waitForSynced(page: Page): Promise<void> {
  await expect(page.getByTestId("sync-status")).toHaveText("synced", {
    timeout: 30_000,
  });
}

async function drawStroke(page: Page, dx: number, dy: number): Promise<void> {
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

async function opsCount(page: Page): Promise<number> {
  const r = await page.request.get(
    `/api/documents/${NOTEBOOK}/pages/${TABS_PAGE}/ops?since=0`,
  );
  return ((await r.json()) as { ops: unknown[] }).ops.length;
}

test("two tabs edit the same page: distinct authors, both converge, no dupes", async ({
  page,
  context,
}) => {
  await page.goto(`/app/${NOTEBOOK}/${TABS_PAGE}`);
  await waitForSynced(page);

  const tab2 = await context.newPage();
  await tab2.goto(`/app/${NOTEBOOK}/${TABS_PAGE}`);
  await waitForSynced(tab2);

  const author1 = await page.evaluate(() => sessionStorage.getItem("weft-author-uuid"));
  const author2 = await tab2.evaluate(() => sessionStorage.getItem("weft-author-uuid"));
  expect(author1).toBeTruthy();
  expect(author2).toBeTruthy();
  expect(author1).not.toBe(author2);

  await drawStroke(page, 200, 200);
  await drawStroke(tab2, 200, 420);
  await waitForSynced(page);
  await waitForSynced(tab2);

  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 20_000 })
    .toBe(2);
  await expect
    .poll(async () => tab2.locator(".tl-shape").count(), { timeout: 20_000 })
    .toBe(2);

  const ops = await opsCount(page);

  await page.reload();
  await waitForSynced(page);
  await expect
    .poll(async () => page.locator(".tl-shape").count(), { timeout: 20_000 })
    .toBe(2);
  expect(await opsCount(page)).toBe(ops);
  await tab2.close();
});

test("a DUPLICATED tab (copied sessionStorage) re-mints its identity", async ({
  page,
  context,
}) => {
  await page.goto(`/app/${NOTEBOOK}/${TABS_PAGE}`);
  await waitForSynced(page);
  const author1 = await page.evaluate(() => sessionStorage.getItem("weft-author-uuid"));

  // new tab with sessionStorage copied from tab1 (simulates duplication)
  const dup = await context.newPage();
  await dup.addInitScript((a) => {
    sessionStorage.setItem("weft-author-uuid", a!);
  }, author1);
  await dup.goto(`/app/${NOTEBOOK}/${TABS_PAGE}`);
  await waitForSynced(dup);

  const authorDup = await dup.evaluate(() => sessionStorage.getItem("weft-author-uuid"));
  expect(authorDup).toBeTruthy();
  expect(authorDup).not.toBe(author1);
  await dup.close();
});
