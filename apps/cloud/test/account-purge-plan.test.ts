import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { RmDocument } from "@weft/rm-format";
import { CloudStore } from "../src/store";
import { ACCOUNT_PURGE_ORDER, planRelayAccountPurge } from "../src/account-purge-plan";

const owner = "test-target", neighbor = "test-neighbor";
const notebook = "notebook", page = "page";
const bytes = new Uint8Array([11, 22, 33]);
const native = RmDocument.empty("aaaaaaaa-0000-4000-a000-000000000001").serialize();

test("the account inventory includes current restore rows and both blob kinds for one account only", () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-purge-plan-"));
  const path = join(dir, "relay.db");
  try {
    const store = new CloudStore(path);
    for (const user of [owner, neighbor]) {
      expect(store.restoreRecoveryNotebook(user, {
        notebook: { id: notebook, name: "Synthetic", pages: [{ id: page, template: "Blank" }] },
        pages: [{ id: page, native, overlay: { shapes: [] }, assets: [{ name: "sample.png", bytes }] }],
      }, "synthetic", () => {})).toBe("created");
      store.putFile(user, notebook, bytes, "application/pdf");
      store.mintDeviceToken(user, "Synthetic tablet");
    }
    const db = new Database(path, { readonly: true });
    try {
      const plan = planRelayAccountPurge(db, owner);
      const counts = Object.fromEntries(plan.rows.map(entry => [entry.table, entry.count]));
      expect(counts).toMatchObject({
        recovery_imports: 1, recovery_epochs: 1, assets: 1,
        page_snapshots: 1, files: 1, device_tokens: 1,
      });
      expect(plan.blobs.map(blob => blob.folder).sort()).toEqual(["", "snapshots"]);
      expect(plan.blobs.find(blob => blob.folder === "")?.name).toBe(
        basename(store.getFileRef(owner, notebook)!.path),
      );
      const other = planRelayAccountPurge(db, neighbor);
      expect(plan.blobs.every(({ name }) => !other.blobs.some(b => b.name === name))).toBe(true);
      expect(plan.blobs.every(({ folder, name }) => existsSync(join(path + "-files", folder, name)))).toBe(true);
      for (const table of ["assets", "overlays", "page_snapshots"] as const) {
        expect(ACCOUNT_PURGE_ORDER.indexOf(table)).toBeLessThan(ACCOUNT_PURGE_ORDER.indexOf("recovery_epochs"));
      }
      expect(store.getFile(owner, notebook)).toEqual(bytes);
      expect(store.getFile(neighbor, notebook)).toEqual(bytes);
    } finally {
      db.close();
    }

    // Exercise ordering against the actual triggers, in a disposable relay.
    // Rolling back also proves the read-only inventory didn't change either account.
    const rehearsal = new Database(path);
    try {
      rehearsal.run("BEGIN");
      for (const table of ACCOUNT_PURGE_ORDER) {
        rehearsal.run(`DELETE FROM ${table} WHERE user_id = ?`, [owner]);
      }
      expect(planRelayAccountPurge(rehearsal, owner).rows.every(entry => entry.count === 0)).toBe(true);
      expect(planRelayAccountPurge(rehearsal, neighbor).blobs).toHaveLength(2);
      rehearsal.run("ROLLBACK");
      expect(planRelayAccountPurge(rehearsal, owner).blobs).toHaveLength(2);
    } finally {
      rehearsal.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema drift and invalid blob names fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-purge-unknown-"));
  const path = join(dir, "relay.db");
  try {
    const store = new CloudStore(path);
    store.putFile(owner, notebook, bytes);
    const db = new Database(path);
    try {
      db.run("CREATE TABLE future_account_metadata (opaque_key TEXT)");
      expect(() => planRelayAccountPurge(db, owner)).toThrow("Relay schema changed");
      db.run("DROP TABLE future_account_metadata");
      db.run("UPDATE files SET path = ? WHERE user_id = ?", ["invalid/../not-a-generated-name", owner]);
      expect(() => planRelayAccountPurge(db, owner)).toThrow("Invalid stored relay blob name");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
