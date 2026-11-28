import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CloudStore } from "../src/store";

test("startup removes an already-fenced source orphan without trapping the account purge", () => {
  const root = mkdtempSync(join(tmpdir(), "weft-account-source-composition-"));
  try {
    const db = join(root, "relay.db");
    const store = new CloudStore(db);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(store.putFile("target", "same", bytes)).toBe(true);
    expect(store.putFile("peer", "same", bytes)).toBe(true);
    const target = store.getFileRef("target", "same")!;
    const peer = store.getFileRef("peer", "same")!;
    store.stageAccountPurge("target");
    expect(existsSync(target.path)).toBe(true);
    const reopened = new CloudStore(db);
    // Source startup cleanup can retire the blob before the account worker
    // resumes. Its still-durable queue entry must safely converge on ENOENT.
    expect(existsSync(target.path)).toBe(false);
    expect(reopened.drainAccountPurge("target")).toEqual({ removed: 1, remaining: 0 });
    expect(existsSync(peer.path)).toBe(true);
    expect(reopened.getFile("peer", "same")).toEqual(bytes);
    expect(() => store.putFile("target", "late", bytes)).toThrow("Account is fenced");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
