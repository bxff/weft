/**
 * #50-lite (D11): PUT /api/documents is a per-doc LWW merge by lastModified,
 * not a blind whole-list swap. Pinned here:
 *  - the RACE the feature exists for: a stale daemon push no longer reverts a
 *    newer web rename (and vice versa — newer daemon metadata beats older web);
 *  - ties -> incoming wins (idempotent re-pushes stay no-ops);
 *  - missing/unparseable lastModified = 0 (pre-#50 lists: always-oldest) and
 *    string-vs-number lastModified both parse (daemon sends numbers, web may
 *    send strings);
 *  - absence semantics: ONLY the authoritative writer (daemon device token —
 *    complete tree) deletes by absence; browser/API writers merge-only;
 *  - cycle/dangling parents clamp to root, nothing is lost;
 *  - malformed input (bad JSON, id-less docs) cannot damage the stored list.
 */

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudStore } from "../src/store";

const U = "u";

function freshStore(): CloudStore {
  return new CloudStore(
    join(mkdtempSync(join(tmpdir(), "weft-docmerge-")), "t.db"),
  );
}

type Doc = {
  id: string;
  name: string;
  parent?: string;
  lastModified?: number | string;
  [k: string]: unknown;
};

const DEV = 'd'.repeat(64) // one device's manifest key (multi-tablet: per-device)
function put(s: CloudStore, docs: Doc[], authoritative: boolean | string = false): Doc[] {
  const key = authoritative === true ? DEV : authoritative === false ? null : authoritative;
  const json = s.mergeDocuments(U, JSON.stringify({ documents: docs }), key);
  return (JSON.parse(json) as { documents: Doc[] }).documents;
}

/** Non-tombstoned ids (deletions are LWW tombstones now, not removed rows). */
function liveIds(docs: Doc[]): string[] {
  return docs.filter((d) => (d as { deleted?: unknown }).deleted !== true).map((d) => d.id).sort();
}

function byId(docs: Doc[], id: string): Doc | undefined {
  return docs.find((d) => d.id === id);
}

test("the race: a stale daemon push does NOT revert a newer web rename", () => {
  const s = freshStore();
  // daemon seeds the tree
  put(s, [{ id: "a", name: "Notes", parent: "", lastModified: 100 }], true);
  // web renames (newer lastModified)
  put(s, [{ id: "a", name: "Renamed", parent: "", lastModified: 200 }]);
  // daemon re-pushes its STALE view of the same doc
  const merged = put(s, [{ id: "a", name: "Notes", parent: "", lastModified: 100 }], true);
  expect(byId(merged, "a")!.name).toBe("Renamed");
});

test("newer daemon metadata beats an older web edit (LWW is symmetric)", () => {
  const s = freshStore();
  put(s, [{ id: "a", name: "Old", parent: "", lastModified: 100 }]);
  const merged = put(s, [{ id: "a", name: "TabletRename", parent: "", lastModified: 300 }], true);
  expect(byId(merged, "a")!.name).toBe("TabletRename");
});

test("tie -> incoming wins (idempotent re-push is a no-op; winning fields travel whole-doc)", () => {
  const s = freshStore();
  put(s, [{ id: "a", name: "One", parent: "", lastModified: 100, zoom: { scale: 1 } }]);
  const merged = put(s, [{ id: "a", name: "Two", parent: "f", lastModified: 100 }]);
  const a = byId(merged, "a")!;
  expect(a.name).toBe("Two");
  // whole-doc LWW: the winner's record replaces the loser's entirely
  expect(a.zoom).toBeUndefined();
  // f dangles -> clamped to root
  expect(a.parent).toBe("");
});

test("missing lastModified = always-oldest (pre-#50 stored lists lose to any versioned edit, and vice versa)", () => {
  const s = freshStore();
  // stored list written by an OLDER build: no lastModified anywhere
  put(s, [{ id: "a", name: "Legacy", parent: "" }]);
  // any versioned edit beats it
  let merged = put(s, [{ id: "a", name: "Versioned", parent: "", lastModified: 5 }]);
  expect(byId(merged, "a")!.name).toBe("Versioned");
  // an INCOMING legacy record (no lm) cannot beat a stored versioned one
  merged = put(s, [{ id: "a", name: "LegacyAgain", parent: "" }]);
  expect(byId(merged, "a")!.name).toBe("Versioned");
});

test("lastModified as a numeric STRING parses (web) and compares against numbers (daemon)", () => {
  const s = freshStore();
  put(s, [{ id: "a", name: "Num", parent: "", lastModified: 100 }], true);
  const merged = put(s, [{ id: "a", name: "Str", parent: "", lastModified: "200" }]);
  expect(byId(merged, "a")!.name).toBe("Str");
  // and a garbage string counts as 0, never NaN-poisoning the compare
  const merged2 = put(s, [{ id: "a", name: "Garbage", parent: "", lastModified: "soon" }]);
  expect(byId(merged2, "a")!.name).toBe("Str");
});

test("absence: the daemon (authoritative) deletes by absence — tablet deletions still propagate", () => {
  const s = freshStore();
  put(s, [
    { id: "a", name: "Keep", parent: "", lastModified: 1 },
    { id: "b", name: "DeletedOnTablet", parent: "", lastModified: 1 },
  ], true);
  const merged = put(s, [{ id: "a", name: "Keep", parent: "", lastModified: 1 }], true);
  // deletion is now a TOMBSTONE (multi-tablet: siblings must see it), so the
  // row stays with deleted:true and only "a" remains live
  expect(liveIds(merged)).toEqual(["a"]);
  expect((byId(merged, "b") as { deleted?: boolean })?.deleted).toBe(true);
});

test("absence: a browser/API partial PUT can NEVER remove docs (merge-only)", () => {
  const s = freshStore();
  put(s, [
    { id: "a", name: "A", parent: "", lastModified: 1 },
    { id: "b", name: "B", parent: "", lastModified: 1 },
  ], true);
  // a third-party app that only knows about doc "a" renames it
  const merged = put(s, [{ id: "a", name: "A2", parent: "", lastModified: 2 }]);
  expect(merged.map((d) => d.id).sort()).toEqual(["a", "b"]);
  expect(byId(merged, "a")!.name).toBe("A2");
});

test("new docs from either side are added", () => {
  const s = freshStore();
  put(s, [{ id: "a", name: "A", parent: "", lastModified: 1 }], true);
  const merged = put(s, [{ id: "web1", name: "FromWeb", parent: "", lastModified: 2 }]);
  expect(merged.map((d) => d.id).sort()).toEqual(["a", "web1"]);
});

test("concurrent cross-moves that form a folder cycle clamp to root; nothing is lost", () => {
  const s = freshStore();
  put(s, [
    { id: "A", name: "FolderA", parent: "", lastModified: 1, type: "folder" },
    { id: "B", name: "FolderB", parent: "", lastModified: 1, type: "folder" },
  ], true);
  // web moves A into B; daemon (newer on B) moves B into A -> cycle A<->B
  put(s, [{ id: "A", name: "FolderA", parent: "B", lastModified: 2, type: "folder" }]);
  const merged = put(s, [{ id: "B", name: "FolderB", parent: "A", lastModified: 3, type: "folder" }]);
  const a = byId(merged, "A")!;
  const b = byId(merged, "B")!;
  // both survive, and at least one is clamped so no parent chain cycles
  expect(merged).toHaveLength(2);
  const parentOf = (id: string) => (byId(merged, id)!.parent as string) ?? "";
  const chainTerminates = (id: string): boolean => {
    const seen = new Set<string>();
    let p = parentOf(id);
    while (p !== "" && p !== "trash") {
      if (seen.has(p) || !byId(merged, p)) return false;
      seen.add(p);
      p = parentOf(p);
    }
    return true;
  };
  expect(chainTerminates("A")).toBe(true);
  expect(chainTerminates("B")).toBe(true);
  expect([a.parent, b.parent]).toContain("");
});

test("a dangling parent (folder missing from the merged tree) clamps to root", () => {
  const s = freshStore();
  const merged = put(s, [
    { id: "a", name: "Orphan", parent: "gone-folder", lastModified: 1 },
  ], true);
  expect(byId(merged, "a")!.parent).toBe("");
});

test("'trash' is a terminal parent, not dangling", () => {
  const s = freshStore();
  const merged = put(s, [
    { id: "a", name: "Trashed", parent: "trash", lastModified: 1 },
  ], true);
  expect(byId(merged, "a")!.parent).toBe("trash");
});

test("malformed input cannot damage the stored list", () => {
  const s = freshStore();
  put(s, [{ id: "a", name: "A", parent: "", lastModified: 1 }], true);
  // bad JSON -> parsed as empty, non-authoritative -> stored list untouched
  s.mergeDocuments(U, "{not json", false);
  // id-less / junk docs are skipped
  s.mergeDocuments(U, JSON.stringify({ documents: [{ name: "no-id" }, 42, null] }), false);
  const docs = (JSON.parse(s.getDocuments(U)) as { documents: Doc[] }).documents;
  expect(docs.map((d) => d.id)).toEqual(["a"]);
});

test("deep but acyclic nesting is untouched by the guard", () => {
  const s = freshStore();
  const merged = put(s, [
    { id: "f1", name: "F1", parent: "", lastModified: 1, type: "folder" },
    { id: "f2", name: "F2", parent: "f1", lastModified: 1, type: "folder" },
    { id: "f3", name: "F3", parent: "f2", lastModified: 1, type: "folder" },
    { id: "d", name: "Doc", parent: "f3", lastModified: 1 },
  ], true);
  expect(byId(merged, "d")!.parent).toBe("f3");
  expect(byId(merged, "f3")!.parent).toBe("f2");
});

test("a 3-node cycle (A->B->C->A) is broken; every doc survives with terminating chains", () => {
  const s = freshStore();
  put(s, [
    { id: "A", name: "A", parent: "", lastModified: 1, type: "folder" },
    { id: "B", name: "B", parent: "A", lastModified: 1, type: "folder" },
    { id: "C", name: "C", parent: "B", lastModified: 1, type: "folder" },
  ], true);
  const merged = put(s, [{ id: "A", name: "A", parent: "C", lastModified: 2, type: "folder" }]);
  expect(merged).toHaveLength(3);
  const parentOf = (id: string) => (byId(merged, id)!.parent as string) ?? "";
  for (const id of ["A", "B", "C"]) {
    const seen = new Set<string>();
    let p = parentOf(id);
    while (p !== "" && p !== "trash") {
      expect(seen.has(p)).toBe(false); // no cycle reachable from any node
      expect(byId(merged, p)).toBeDefined(); // no dangling hop either
      seen.add(p);
      p = parentOf(p);
    }
  }
});

test("a self-parent (A.parent = A) clamps to root", () => {
  const s = freshStore();
  const merged = put(s, [
    { id: "A", name: "Selfie", parent: "A", lastModified: 1, type: "folder" },
  ], true);
  expect(byId(merged, "A")!.parent).toBe("");
});

// ----- HTTP level: the real auth paths drive authoritative-vs-merge -----

import { startCloud, type CloudServer } from "../src/server";

test("HTTP: device-token PUT deletes by absence; browser PUT cannot; LWW holds end-to-end", async () => {
  process.env.CLOUD_DEV_USER = "1";
  const server: CloudServer = startCloud({ port: 0 });
  try {
    const base = `http://localhost:${server.port}`;
    const USER = "docmerge";
    const devToken = server.store.mintDeviceToken(USER, "test-tablet");
    const asDaemon = (body: unknown) =>
      fetch(`${base}/api/documents`, {
        method: "PUT",
        headers: { "x-device-token": devToken, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const asBrowser = (body: unknown) =>
      fetch(`${base}/api/documents`, {
        method: "PUT",
        headers: { authorization: `Bearer dev:${USER}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const list = async (): Promise<Doc[]> => {
      const r = await fetch(`${base}/api/documents`, {
        headers: { authorization: `Bearer dev:${USER}` },
      });
      return ((await r.json()) as { documents: Doc[] }).documents;
    };

    // daemon seeds two docs
    expect((await asDaemon({ documents: [
      { id: "a", name: "A", parent: "", lastModified: 100 },
      { id: "b", name: "B", parent: "", lastModified: 100 },
    ] })).status).toBe(200);

    // browser renames doc a (newer), pushing a PARTIAL list — b must survive
    expect((await asBrowser({ documents: [
      { id: "a", name: "A-web", parent: "", lastModified: 200 },
    ] })).status).toBe(200);
    let docs = await list();
    expect(docs.map((d) => d.id).sort()).toEqual(["a", "b"]);
    expect(byId(docs, "a")!.name).toBe("A-web");

    // daemon re-pushes its stale view WITHOUT b (deleted on tablet):
    // b disappears (authoritative absence), a keeps the newer web rename (LWW)
    expect((await asDaemon({ documents: [
      { id: "a", name: "A", parent: "", lastModified: 100 },
    ] })).status).toBe(200);
    docs = await list();
    expect(docs.map((d) => d.id)).toEqual(["a"]);
    expect(byId(docs, "a")!.name).toBe("A-web");
  } finally {
    server.stop();
  }
});

test("an EMPTY authoritative push never wipes the library (malformed body / factory-reset guard)", () => {
  const s = freshStore();
  put(s, [
    { id: "a", name: "A", parent: "", lastModified: 1 },
    { id: "b", name: "B", parent: "", lastModified: 1 },
  ], true);
  // zero-doc authoritative pushes: empty list, junk-only list, bad JSON
  expect(put(s, [], true).map((d) => d.id).sort()).toEqual(["a", "b"]);
  s.mergeDocuments(U, JSON.stringify({ documents: [null, { name: "no-id" }] }), DEV);
  s.mergeDocuments(U, "not json at all", DEV);
  const docs = (JSON.parse(s.getDocuments(U)) as { documents: Doc[] }).documents;
  expect(docs.map((d) => d.id).sort()).toEqual(["a", "b"]);
  // but a NON-empty authoritative push still deletes by absence one at a time
  // (as a tombstone: siblings must observe it)
  const merged = put(s, [{ id: "a", name: "A", parent: "", lastModified: 1 }], true);
  expect(liveIds(merged)).toEqual(["a"]);
});

test("a web-created doc (create:true) survives the daemon's authoritative absence-removal", () => {
  const s = freshStore();
  // web creates a folder — lives only in the cloud until the daemon materializes it
  put(s, [{ id: "webfolder", name: "New folder", type: "folder", create: true, lastModified: 100 }]);
  // an existing tablet doc
  put(s, [{ id: "tabletdoc", name: "Note", lastModified: 100 }], true);
  // the daemon's authoritative push does NOT contain the web folder (not on tablet yet)
  const after = put(s, [{ id: "tabletdoc", name: "Note", lastModified: 200 }], true);
  // the web folder must NOT be deleted by absence
  expect(byId(after, "webfolder")).toBeTruthy();
  expect(byId(after, "webfolder")!.create).toBe(true);
  // once the daemon materializes + pushes it back WITHOUT the marker, it's normal
  const done = put(
    s,
    [
      { id: "tabletdoc", name: "Note", lastModified: 300 },
      { id: "webfolder", name: "New folder", type: "folder", lastModified: 300 },
    ],
    true,
  );
  expect(byId(done, "webfolder")!.create).toBeUndefined();
  // and now a real tablet deletion (absence) DOES delete it (tombstone)
  const gone = put(s, [{ id: "tabletdoc", name: "Note", lastModified: 400 }], true);
  expect((byId(gone, "webfolder") as { deleted?: boolean })?.deleted).toBe(true);
})

test("#80: a web MOVE (fieldStamps.parent) never clobbers a concurrent tablet RENAME", () => {
  const s = freshStore();
  const U = "perfield";
  // t=1: daemon pushes the doc (and the target folder, so the move's parent
  // is a real node — dangling parents clamp to root by design)
  s.mergeDocuments(
    U,
    JSON.stringify({
      documents: [
        { id: "folderX", name: "Folder X", parent: "", type: "folder", lastModified: 1000 },
        { id: "d1", name: "Old Name", parent: "", lastModified: 1000 },
      ],
    }),
    true,
  );
  // t=2: the tablet RENAMES (daemon push, whole-doc stamp)
  s.mergeDocuments(
    U,
    JSON.stringify({
      documents: [
        { id: "folderX", name: "Folder X", parent: "", type: "folder", lastModified: 1000 },
        { id: "d1", name: "Tablet Rename", parent: "", lastModified: 2000 },
      ],
    }),
    true,
  );
  // t=3: the web MOVES using a STALE copy (fetched before the rename) but
  // claims ONLY the parent field
  s.mergeDocuments(
    U,
    JSON.stringify({
      documents: [
        {
          id: "d1",
          name: "Old Name", // stale carried value
          parent: "folderX",
          lastModified: 3000,
          fieldStamps: { parent: 3000 },
        },
      ],
    }),
    false,
  );
  const docs = (JSON.parse(s.getDocuments(U)) as { documents: { id: string; name: string; parent: string; lastModified: number }[] }).documents;
  const d1 = docs.find((d) => d.id === "d1")!;
  expect(d1.name).toBe("Tablet Rename"); // the rename SURVIVES the move
  expect(d1.parent).toBe("folderX"); // and the move landed
  expect(d1.lastModified).toBe(3000); // device-ward apply will fire
  // the reverse race: tablet rename arrives AFTER the web move
  s.mergeDocuments(
    U,
    JSON.stringify({
      documents: [
        { id: "folderX", name: "Folder X", parent: "", type: "folder", lastModified: 1000 },
        { id: "d1", name: "Rename Two", parent: "", lastModified: 4000 },
      ],
    }),
    true,
  );
  const d2 = (JSON.parse(s.getDocuments(U)) as { documents: { id: string; name: string; parent: string }[] }).documents.find((d) => d.id === "d1")!;
  expect(d2.name).toBe("Rename Two");
  // the daemon's whole-doc claim wins parent too (it pulled the move first
  // in the real flow: pull-before-push); per-field stamps recorded either way
});
