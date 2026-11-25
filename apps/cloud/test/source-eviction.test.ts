/**
 * #81: source-file LRU eviction. When the per-user PDF (sources) quota is full,
 * pushing a MORE-recently-opened source evicts the COLDEST resident source to
 * make room; a source colder than all residents stays tablet-only. GET
 * /api/sources reports residency so the daemon can re-push an evicted-but-hot
 * source.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCloud, type CloudServer } from "../src/server";

let server: CloudServer;
let base: string;
let dev: string;
const USER = "evict";
const dh = () => ({ "x-device-token": dev });

async function pushDocList(
  docs: { id: string; lastOpened: number }[],
): Promise<void> {
  await fetch(`${base}/api/documents`, {
    method: "PUT",
    headers: { "x-device-token": dev, "content-type": "application/json" },
    body: JSON.stringify({
      documents: docs.map((d) => ({
        id: d.id,
        name: d.id,
        parent: "",
        type: "pdf",
        lastModified: d.lastOpened,
        lastOpened: d.lastOpened,
      })),
    }),
  });
}
async function pushFile(doc: string, size: number): Promise<number> {
  const r = await fetch(`${base}/api/documents/${doc}/file`, {
    method: "PUT",
    headers: { ...dh(), "content-type": "application/pdf" },
    body: new Uint8Array(size).fill(1),
  });
  return r.status;
}
async function resident(): Promise<string[]> {
  const r = await fetch(`${base}/api/sources`, { headers: dh() });
  return ((await r.json()) as { docs: string[] }).docs.sort();
}
async function fileStatus(doc: string): Promise<number> {
  const r = await fetch(`${base}/api/documents/${doc}/file`, { headers: dh() });
  return r.status; // 200 resident, 204 tablet-only
}

beforeAll(async () => {
  process.env.CLOUD_DEV_USER = "1";
  server = startCloud({ port: 0 });
  base = `http://localhost:${server.port}`;
  dev = server.store.mintDeviceToken(USER, "t");
  // PDF space = 1000 bytes; each source is 500 -> only two fit.
  server.store.setUserQuota(USER, "sources", 1000);
  await pushDocList([
    { id: "A", lastOpened: 100 }, // coldest
    { id: "B", lastOpened: 200 },
    { id: "C", lastOpened: 300 }, // hottest
    { id: "D", lastOpened: 50 }, // colder than everything
  ]);
});
afterAll(() => server.stop());

test("hotter source evicts the coldest resident; colder-than-all stays tablet-only", async () => {
  expect(await pushFile("A", 500)).toBe(200);
  expect(await pushFile("B", 500)).toBe(200); // budget now full (A+B = 1000)
  expect((await resident()).sort()).toEqual(["A", "B"]);

  // push C (hotter than A and B) -> evicts the COLDEST resident (A) to fit
  expect(await pushFile("C", 500)).toBe(200);
  expect(await resident()).toEqual(["B", "C"]);
  expect(await fileStatus("A")).toBe(204); // A evicted -> tablet-only
  expect(await fileStatus("C")).toBe(200); // C resident

  // A re-opened (now hottest) re-pushes and evicts the coldest resident (B)
  await pushDocList([
    { id: "A", lastOpened: 400 },
    { id: "B", lastOpened: 200 },
    { id: "C", lastOpened: 300 },
    { id: "D", lastOpened: 50 },
  ]);
  expect(await pushFile("A", 500)).toBe(200);
  expect(await resident()).toEqual(["A", "C"]);
  expect(await fileStatus("B")).toBe(204);

  // D is colder than every resident -> nothing to evict -> 507 (tablet-only)
  expect(await pushFile("D", 500)).toBe(507);
  expect(await fileStatus("D")).toBe(204);
  expect(await resident()).toEqual(["A", "C"]); // unchanged
});
