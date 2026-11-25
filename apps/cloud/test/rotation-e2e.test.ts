/**
 * #81 rotation END-TO-END: replicate the daemon's source-push DECISION loop
 * (device/rmsyncd/src/cloud.rs reconcile_all) driving the REAL cloud eviction,
 * over a sequence of "opens", and assert the right PDFs stay resident, no
 * thrash, and nothing is ever lost. This is the real-flow test that was missing
 * (the daemon budget-gate bug made server eviction dead code on-device).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { startCloud, type CloudServer } from "../src/server";

let server: CloudServer;
let base: string;
let dev: string;
const USER = "rot";

beforeEach(() => {
  process.env.CLOUD_DEV_USER = "1";
  server = startCloud({ port: 0 });
  base = `http://localhost:${server.port}`;
  dev = server.store.mintDeviceToken(USER, "t");
});
afterEach(() => server.stop());

const dh = () => ({ "x-device-token": dev });

// mirror the tablet's real state: each doc has a source of `size` and a
// lastOpened. `resident` mirrors the daemon's cloud.files dedup cache.
type Src = { id: string; size: number; lastOpened: number };

async function pushDocList(docs: Src[]) {
  await fetch(`${base}/api/documents`, {
    method: "PUT",
    headers: { ...dh(), "content-type": "application/json" },
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
async function serverResident(): Promise<string[]> {
  const r = await fetch(`${base}/api/sources`, { headers: dh() });
  return ((await r.json()) as { docs: string[] }).docs.sort();
}

/**
 * One daemon reconcile pass over the sources, faithfully mirroring the Rust
 * `reconcile_all` phase-2 logic AFTER the #81 daemon fix:
 *  - forget dedup for any source the cloud evicted (retain resident only);
 *  - coldest_resident_lo = min lastOpened among resident docs;
 *  - hottest-first; a source HOTTER than the coldest resident is attempted with
 *    an unlimited budget (server evicts a colder one); otherwise it takes the
 *    free budget and is skipped (TooBig) if it doesn't fit.
 * Returns the number of actual uploads attempted (to detect thrash).
 */
async function daemonReconcile(
  docs: Src[],
  dedup: Set<string>,
  limit: number,
): Promise<number> {
  const resident = await serverResident();
  // retain: forget evicted docs so they can re-push
  for (const id of [...dedup]) if (!resident.includes(id)) dedup.delete(id);

  const loOf = new Map(docs.map((d) => [d.id, d.lastOpened]));
  const presentResident = resident.filter((id) => loOf.has(id));
  const coldestResidentLo =
    presentResident.length === 0
      ? null
      : Math.min(...presentResident.map((id) => loOf.get(id)!));

  let used = () =>
    docs.filter((d) => resident.includes(d.id)).reduce((n, d) => n + d.size, 0);
  const order = [...docs].sort((a, b) => b.lastOpened - a.lastOpened); // hottest first
  let free = limit - used();
  let uploads = 0;
  for (const d of order) {
    if (dedup.has(d.id)) continue; // mtime dedup: already pushed + still resident
    const hotter = coldestResidentLo !== null && d.lastOpened > coldestResidentLo;
    // free-budget path: skip if it does not fit (TooBig, no upload)
    if (!hotter && d.size > free) continue;
    // send the PUT (the server evicts colder residents to fit if needed)
    uploads++;
    const r = await fetch(`${base}/api/documents/${d.id}/file`, {
      method: "PUT",
      headers: { ...dh(), "content-type": "application/pdf" },
      body: new Uint8Array(d.size).fill(1),
    });
    if (r.status === 200) {
      dedup.add(d.id);
      if (!hotter) free -= d.size; // debit only the free-budget path
    }
    else if (r.status === 507) break; // faithful to Rust: QuotaFull breaks the source phase
  }
  return uploads;
}

test("hottest PDFs stay resident across a sequence of opens; re-open brings a rolled-off one back", async () => {
  server.store.setUserQuota(USER, "sources", 1000); // fits exactly 2 of 3 (500 each)
  const docs: Src[] = [
    { id: "A", size: 500, lastOpened: 100 },
    { id: "B", size: 500, lastOpened: 200 },
    { id: "C", size: 500, lastOpened: 300 },
  ];
  const dedup = new Set<string>();

  await pushDocList(docs);
  await daemonReconcile(docs, dedup, 1000); // initial fill: C(300),B(200) resident, A skipped
  expect(await serverResident()).toEqual(["B", "C"]);

  // OPEN A (now hottest) -> it must come back, evicting the coldest resident (B)
  docs.find((d) => d.id === "A")!.lastOpened = 400;
  await pushDocList(docs);
  await daemonReconcile(docs, dedup, 1000);
  expect(await serverResident()).toEqual(["A", "C"]);

  // OPEN B again (hottest) -> back, evicting the coldest resident (C)
  docs.find((d) => d.id === "B")!.lastOpened = 500;
  await pushDocList(docs);
  await daemonReconcile(docs, dedup, 1000);
  expect(await serverResident()).toEqual(["A", "B"]);
});

test("no thrash: repeated reconciles with NO opens upload nothing and keep residency stable", async () => {
  server.store.setUserQuota(USER, "sources", 1000);
  const docs: Src[] = [
    { id: "A", size: 500, lastOpened: 100 },
    { id: "B", size: 500, lastOpened: 200 },
    { id: "C", size: 500, lastOpened: 300 },
  ];
  const dedup = new Set<string>();
  await pushDocList(docs);
  await daemonReconcile(docs, dedup, 1000);
  const first = await serverResident();
  // 5 more passes, nothing opened -> ZERO uploads, residency unchanged (no push<->evict oscillation)
  for (let i = 0; i < 5; i++) {
    const uploads = await daemonReconcile(docs, dedup, 1000);
    expect(uploads).toBe(0);
    expect(await serverResident()).toEqual(first);
  }
});

test("a PDF colder than every resident stays tablet-only (never evicts a hotter one)", async () => {
  server.store.setUserQuota(USER, "sources", 1000);
  const docs: Src[] = [
    { id: "A", size: 500, lastOpened: 200 },
    { id: "B", size: 500, lastOpened: 300 },
    { id: "COLD", size: 500, lastOpened: 50 },
  ];
  const dedup = new Set<string>();
  await pushDocList(docs);
  await daemonReconcile(docs, dedup, 1000);
  // A,B resident; COLD colder than both -> not resident, and A/B untouched
  expect(await serverResident()).toEqual(["A", "B"]);
});

test("data safety: an evicted source is never lost — re-open re-uploads its exact bytes", async () => {
  server.store.setUserQuota(USER, "sources", 1000);
  const docs: Src[] = [
    { id: "A", size: 500, lastOpened: 100 },
    { id: "B", size: 500, lastOpened: 200 },
    { id: "C", size: 500, lastOpened: 300 },
  ];
  const dedup = new Set<string>();
  await pushDocList(docs);
  await daemonReconcile(docs, dedup, 1000); // A evicted (coldest)
  expect(await serverResident()).not.toContain("A");
  // re-open A
  docs.find((d) => d.id === "A")!.lastOpened = 400;
  await pushDocList(docs);
  await daemonReconcile(docs, dedup, 1000);
  // A resident again with full bytes
  const r = await fetch(`${base}/api/documents/A/file`, { headers: dh() });
  expect(r.status).toBe(200);
  expect(new Uint8Array(await r.arrayBuffer()).length).toBe(500);
});

test("unlimited quota (limit 0): eviction never runs, everything resident", async () => {
  server.store.setUserQuota(USER, "sources", 0); // 0 = unlimited
  const docs: Src[] = [
    { id: "A", size: 500, lastOpened: 100 },
    { id: "B", size: 500, lastOpened: 200 },
    { id: "C", size: 500, lastOpened: 300 },
  ];
  const dedup = new Set<string>();
  await pushDocList(docs);
  // with unlimited, free is Infinity; mirror by a huge limit
  await daemonReconcile(docs, dedup, Number.MAX_SAFE_INTEGER);
  expect(await serverResident()).toEqual(["A", "B", "C"]);
});

test("atomic eviction: a hot source too big to fit even after evicting all colder evicts NOTHING", async () => {
  server.store.setUserQuota(USER, "sources", 1000);
  const put = async (id: string, size: number) => {
    const r = await fetch(`${base}/api/documents/${id}/file`, {
      method: "PUT", headers: { ...dh(), "content-type": "application/pdf" },
      body: new Uint8Array(size).fill(1),
    });
    return r.status;
  };
  await pushDocList([
    { id: "R", size: 100, lastOpened: 100 },
    { id: "H", size: 800, lastOpened: 900 },
    { id: "X", size: 500, lastOpened: 500 },
  ]);
  expect(await put("R", 100)).toBe(200);
  expect(await put("H", 800)).toBe(200); // usage 900/1000
  // X hotter than R(coldest) but 500 > free(100)+evictable-colder(R=100)=200
  expect(await put("X", 500)).toBe(507);
  // R must NOT have been evicted for nothing (atomic eviction)
  expect((await serverResident()).sort()).toEqual(["H", "R"]);
});

test("re-import a resident PDF near quota nets the delta (new-old), doesn't over-evict", async () => {
  server.store.setUserQuota(USER, "sources", 1000);
  const put = async (id: string, size: number) => {
    const r = await fetch(`${base}/api/documents/${id}/file`, {
      method: "PUT", headers: { ...dh(), "content-type": "application/pdf" },
      body: new Uint8Array(size).fill(1),
    });
    return r.status;
  };
  await pushDocList([
    { id: "A", size: 400, lastOpened: 100 },
    { id: "B", size: 400, lastOpened: 200 },
  ]);
  expect(await put("A", 400)).toBe(200);
  expect(await put("B", 400)).toBe(200); // usage 800/1000
  // re-import A at 500: net +100 -> 900 <= 1000, fits WITHOUT evicting B
  expect(await put("A", 500)).toBe(200);
  expect((await serverResident()).sort()).toEqual(["A", "B"]);
  const ar = await fetch(`${base}/api/documents/A/file`, { headers: dh() });
  expect(new Uint8Array(await ar.arrayBuffer()).length).toBe(500);
});
