/**
 * #54 phase 1: selective sync. Pinned:
 *  - GET/PUT /api/sync-exclusions round-trips and validates input;
 *  - the storageGuard backstop: writes to an excluded doc 403
 *    { reason: "excluded" } across the write surfaces (blob PUT, ops POST),
 *    including docs excluded via an ANCESTOR folder;
 *  - reads of already-stored content keep working (phase 1 never deletes —
 *    purging already-synced bytes is #50-full);
 *  - clearing the exclusion re-enables writes.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCloud, type CloudServer } from "../src/server";

let server: CloudServer;
let base: string;
const USER = "sel";
const h = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer dev:${USER}`,
  ...extra,
});

beforeAll(async () => {
  process.env.CLOUD_DEV_USER = "1";
  server = startCloud({ port: 0 });
  base = `http://localhost:${server.port}`;
  // doc tree: folder F > doc childdoc; top-level doc topdoc
  const dev = server.store.mintDeviceToken(USER, "t");
  await fetch(`${base}/api/documents`, {
    method: "PUT",
    headers: { "x-device-token": dev, "content-type": "application/json" },
    body: JSON.stringify({
      documents: [
        { id: "F", name: "Folder", parent: "", type: "folder", lastModified: 1 },
        { id: "childdoc", name: "Child", parent: "F", lastModified: 1 },
        { id: "topdoc", name: "Top", parent: "", lastModified: 1 },
      ],
    }),
  });
  // topdoc has pre-existing content
  await fetch(`${base}/api/documents/topdoc/pages/p1/rm`, {
    method: "PUT",
    headers: h({ "content-type": "application/octet-stream" }),
    body: new Uint8Array(500).fill(7),
  });
});
afterAll(() => server.stop());

test("exclusions round-trip; junk is rejected", async () => {
  const put = await fetch(`${base}/api/sync-exclusions`, {
    method: "PUT",
    headers: h({ "content-type": "application/json" }),
    body: JSON.stringify({ docs: ["topdoc", "F"] }),
  });
  expect(put.status).toBe(200);
  const got = (await (
    await fetch(`${base}/api/sync-exclusions`, { headers: h() })
  ).json()) as { docs: string[] };
  expect(got.docs.sort()).toEqual(["F", "topdoc"]);

  for (const bad of [{ docs: "x" }, { docs: [42] }, { docs: ["a/b"] }]) {
    const r = await fetch(`${base}/api/sync-exclusions`, {
      method: "PUT",
      headers: h({ "content-type": "application/json" }),
      body: JSON.stringify(bad),
    });
    expect(r.status).toBe(400);
  }
  // the failed PUTs did not clobber the stored set
  const still = (await (
    await fetch(`${base}/api/sync-exclusions`, { headers: h() })
  ).json()) as { docs: string[] };
  expect(still.docs.sort()).toEqual(["F", "topdoc"]);
});

test("writes to an excluded doc 403 (direct + via ancestor folder); reads keep working", async () => {
  // direct exclusion: blob write refused
  const blob = await fetch(`${base}/api/documents/topdoc/pages/p1/rm`, {
    method: "PUT",
    headers: h({ "content-type": "application/octet-stream" }),
    body: new Uint8Array(100).fill(1),
  });
  expect(blob.status).toBe(403);
  expect(((await blob.json()) as { reason?: string }).reason).toBe("excluded");

  // ancestor exclusion (childdoc lives under excluded folder F): ops refused
  const ops = await fetch(`${base}/api/documents/childdoc/pages/p1/ops`, {
    method: "POST",
    headers: h({ "content-type": "application/json" }),
    body: JSON.stringify({ ops: [], author: "web" }),
  });
  expect(ops.status).toBe(403);

  // phase 1 never deletes: the pre-existing content still reads fine
  const read = await fetch(`${base}/api/documents/topdoc/pages/p1/rm`, {
    headers: h(),
  });
  expect(read.status).toBe(200);
  expect((await read.arrayBuffer()).byteLength).toBe(500);
});

test("clearing the exclusions re-enables writes; unrelated docs were never affected", async () => {
  // unrelated doc writes fine even while exclusions exist
  const other = await fetch(`${base}/api/documents/otherdoc/pages/p1/rm`, {
    method: "PUT",
    headers: h({ "content-type": "application/octet-stream" }),
    body: new Uint8Array(100).fill(2),
  });
  expect(other.status).toBe(200);

  await fetch(`${base}/api/sync-exclusions`, {
    method: "PUT",
    headers: h({ "content-type": "application/json" }),
    body: JSON.stringify({ docs: [] }),
  });
  // the CAS-free op path re-opens for the previously folder-excluded doc
  const ops = await fetch(`${base}/api/documents/childdoc/pages/p1/ops`, {
    method: "POST",
    headers: h({ "content-type": "application/json" }),
    body: JSON.stringify({ ops: [], author: "web" }),
  });
  expect(ops.status).toBe(200);
});

test("excluded doc keeps its display info for re-inclusion after the daemon drops it (#54 re-tick)", async () => {
  // exclude topdoc (still present in the list at this point)
  await fetch(`${base}/api/sync-exclusions`, {
    method: "PUT",
    headers: h({ "content-type": "application/json" }),
    body: JSON.stringify({ docs: ["topdoc"] }),
  });
  const info1 = (await (
    await fetch(`${base}/api/sync-exclusions`, { headers: h() })
  ).json()) as { docs: string[]; info: { id: string; name: string; type: string }[] };
  const top1 = info1.info.find((e) => e.id === "topdoc");
  expect(top1?.name).toBe("Top"); // captured while it was in the list

  // simulate the daemon dropping the excluded doc from the cloud list (an
  // authoritative device push that no longer contains topdoc)
  const dev = server.store.mintDeviceToken(USER, "t2");
  await fetch(`${base}/api/documents`, {
    method: "PUT",
    headers: { "x-device-token": dev, "content-type": "application/json" },
    body: JSON.stringify({
      documents: [
        { id: "F", name: "Folder", parent: "", type: "folder", lastModified: 2 },
        { id: "childdoc", name: "Child", parent: "F", lastModified: 2 },
      ],
    }),
  });
  // topdoc is now gone from GET /api/documents...
  const docs = (await (
    await fetch(`${base}/api/documents`, { headers: h() })
  ).json()) as { documents: { id: string }[] };
  expect(docs.documents.some((d) => d.id === "topdoc")).toBe(false);

  // ...but a re-PUT of the same exclusion set still REMEMBERS its name, so the
  // settings UI can render it for re-ticking (the bug: it used to vanish)
  await fetch(`${base}/api/sync-exclusions`, {
    method: "PUT",
    headers: h({ "content-type": "application/json" }),
    body: JSON.stringify({ docs: ["topdoc"] }),
  });
  const info2 = (await (
    await fetch(`${base}/api/sync-exclusions`, { headers: h() })
  ).json()) as { info: { id: string; name: string }[] };
  expect(info2.info.find((e) => e.id === "topdoc")?.name).toBe("Top");

  // re-include: clearing the exclusion works
  const clear = await fetch(`${base}/api/sync-exclusions`, {
    method: "PUT",
    headers: h({ "content-type": "application/json" }),
    body: JSON.stringify({ docs: [] }),
  });
  expect(clear.status).toBe(200);
});

test("web GET /api/documents hides excluded docs (offline-safe); daemon still sees full tree (#A1)", async () => {
  const dev = server.store.mintDeviceToken(USER, "t3");
  await fetch(`${base}/api/documents`, {
    method: "PUT",
    headers: { "x-device-token": dev, "content-type": "application/json" },
    body: JSON.stringify({
      documents: [
        { id: "Fx", name: "Folder", parent: "", type: "folder", lastModified: 9 },
        { id: "kid", name: "Kid", parent: "Fx", lastModified: 9 },
        { id: "solo", name: "Solo", parent: "", lastModified: 9 },
      ],
    }),
  });
  // exclude the FOLDER (should hide the folder AND its child on the web)
  await fetch(`${base}/api/sync-exclusions`, {
    method: "PUT",
    headers: h({ "content-type": "application/json" }),
    body: JSON.stringify({ docs: ["Fx"] }),
  });

  // web view: Fx + kid hidden, solo visible — WITHOUT any daemon push
  const web = (await (
    await fetch(`${base}/api/documents`, { headers: h() })
  ).json()) as { documents: { id: string }[] };
  const webIds = web.documents.map((d) => d.id);
  expect(webIds).toContain("solo");
  expect(webIds).not.toContain("Fx");
  expect(webIds).not.toContain("kid"); // hidden via ancestor folder

  // daemon (device token) still sees the FULL authoritative tree
  const dm = (await (
    await fetch(`${base}/api/documents`, { headers: { "x-device-token": dev } })
  ).json()) as { documents: { id: string }[] };
  const dmIds = dm.documents.map((d) => d.id);
  expect(dmIds).toContain("Fx");
  expect(dmIds).toContain("kid");

  await fetch(`${base}/api/sync-exclusions`, {
    method: "PUT",
    headers: h({ "content-type": "application/json" }),
    body: JSON.stringify({ docs: [] }),
  });
})

test("#83: the daemon's excludedInfo sidecar backfills null-name exclusion rows", async () => {
  const U2 = "sel-backfill";
  const dev = server.store.mintDeviceToken(U2, "t2");
  // a doc excluded BEFORE the name-capture fix: row exists, name unknown
  server.store.setSyncExclusions(U2, ["olddoc"]);
  expect(server.store.getExcludedDocInfo(U2)[0]).toMatchObject({
    id: "olddoc",
    name: null,
  });
  // the daemon pushes its (filtered) list WITH the identity sidecar
  const r = await fetch(`${base}/api/documents`, {
    method: "PUT",
    headers: { "x-device-token": dev, "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ id: "visible", name: "Visible", parent: "", lastModified: 5 }],
      excludedInfo: [
        { id: "olddoc", name: "My Private Notes", type: "notebook", parent: "" },
        { id: "not-excluded", name: "Junk" }, // no row: must NOT create one
      ],
    }),
  });
  expect(r.status).toBe(200);
  const info = server.store.getExcludedDocInfo(U2);
  expect(info).toHaveLength(1); // backfill never creates exclusions
  expect(info[0]).toMatchObject({ id: "olddoc", name: "My Private Notes", type: "notebook" });
  // the stored doc list must NOT leak excluded identity (sidecar dropped)
  expect(server.store.getDocuments(U2)).not.toContain("My Private Notes");
  // a session-authed (web) push cannot backfill (device only)
  server.store.setSyncExclusions(U2, ["olddoc"]); // reset name via re-capture path keeps it
  const web = await fetch(`${base}/api/documents`, {
    method: "PUT",
    headers: h(),
    body: JSON.stringify({
      documents: [],
      excludedInfo: [{ id: "olddoc", name: "SPOOFED" }],
    }),
  });
  expect(web.status).toBe(200);
  expect(server.store.getExcludedDocInfo(U2)[0]!.name).not.toBe("SPOOFED");
});
