import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { RmDocument } from "@weft/rm-format";
import { encodeSnapshot } from "@weft/sync-engine";
import { CloudStore } from "../src/store";
import { planRelayAccountPurge } from "../src/account-purge-plan";
import { startCloud } from "../src/server";

const target = "synthetic-target", other = "synthetic-other";
const doc = "same-doc", page = "same-page";
const bytes = new Uint8Array([10, 20, 30]);
const native = RmDocument.empty("aaaaaaaa-0000-4000-a000-000000000001").serialize();
const snapshot = encodeSnapshot(native, { shapes: [] });

function connection(store: CloudStore): Database {
  return (store as unknown as { db: Database }).db;
}

function close(store: CloudStore): void {
  connection(store).close();
}

function seed(store: CloudStore, user: string): void {
  expect(store.restoreRecoveryNotebook(user, {
    notebook: { id: doc, name: "Synthetic", pages: [{ id: page, template: "Blank" }] },
    pages: [{ id: page, native, overlay: { shapes: [] }, assets: [{ name: "sample.png", bytes }] }],
  }, "synthetic", () => {})).toBe("created");
  store.putFile(user, doc, bytes);
  store.mintDeviceToken(user, "Synthetic tablet");
}

test("SQL purge rolls back together, then persisted fence and tracked file work survive reopening", () => {
  const root = mkdtempSync(join(tmpdir(), "weft-account-purge-"));
  const path = join(root, "relay.db"), files = path + "-files";
  const store = new CloudStore(path);
  let reopened: CloudStore | undefined;
  let delayed: CloudStore | undefined;
  const db = new Database(path);
  try {
    seed(store, target);
    seed(store, other);
    delayed = new CloudStore(path);
    const targetPlan = planRelayAccountPurge(db, target);
    const targetBlobs = targetPlan.blobs;
    const syncSetting = () => connection(store).query("PRAGMA synchronous").get();
    expect(syncSetting()).toEqual({ synchronous: 1 });
    expect(() => connection(store).transaction(() => store.stageAccountPurge(target))())
      .toThrow("requires its own transaction");
    const otherBlobs = planRelayAccountPurge(db, other).blobs;
    db.run(`CREATE TRIGGER fail_purge BEFORE DELETE ON files
      WHEN OLD.user_id='synthetic-target' BEGIN SELECT RAISE(ABORT,'injected'); END`);
    expect(() => store.stageAccountPurge(target)).toThrow("injected");
    expect(store.isAccountFenced(target)).toBe(false);
    expect(planRelayAccountPurge(db, target)).toEqual(targetPlan);
    expect(syncSetting()).toEqual({ synchronous: 1 });
    expect(db.query("SELECT count(*) AS n FROM account_purge_files").get()).toEqual({ n: 0 });
    expect(targetBlobs.every(b => existsSync(join(files, b.folder, b.name)))).toBe(true);
    db.run("DROP TRIGGER fail_purge");

    store.stageAccountPurge(target);
    expect(syncSetting()).toEqual({ synchronous: 1 });
    expect(() => connection(store).transaction(() => store.drainAccountPurge(target))())
      .toThrow("requires its own writer transaction");
    expect(planRelayAccountPurge(db, target).rows.every(row => row.count === 0)).toBe(true);
    expect(planRelayAccountPurge(db, other).blobs).toEqual(otherBlobs);
    expect(targetBlobs.every(b => existsSync(join(files, b.folder, b.name)))).toBe(true);
    // Simulate a writer that opened the DB before the purge, such as a relay
    // request stalled reading its HTTP body. It cannot recreate data or files.
    const filesBefore = [readdirSync(files).length, readdirSync(join(files, "snapshots")).length];
    expect(() => delayed!.putFile(target, "late-file", bytes)).toThrow("Account is fenced");
    expect(() => delayed!.putSnapshot(target, doc, page, snapshot)).toThrow("Account is fenced");
    expect(() => delayed!.mintDeviceToken(target, "Late device")).toThrow("Account is fenced");
    expect(() => delayed!.putPage(target, doc, page, "", native, "late")).toThrow("Account is fenced");
    expect([readdirSync(files).length, readdirSync(join(files, "snapshots")).length]).toEqual(filesBefore);
    expect(delayed.getFile(other, doc)).toEqual(bytes);

    // Interruption after unlink but before retiring the journal item.
    const missing = targetBlobs[0]!;
    unlinkSync(join(files, missing.folder, missing.name));
    close(delayed);
    delayed = undefined;
    close(store);
    reopened = new CloudStore(path);
    expect(reopened.isAccountFenced(target)).toBe(true);
    expect(reopened.isAccountFenced(other)).toBe(false);
    reopened.stageAccountPurge(target);
    expect(reopened.drainAccountPurge(target)).toEqual({ removed: 2, remaining: 0 });
    expect(reopened.drainAccountPurge(target)).toEqual({ removed: 0, remaining: 0 });
    expect(targetBlobs.every(b => !existsSync(join(files, b.folder, b.name)))).toBe(true);
    expect(otherBlobs.every(b => existsSync(join(files, b.folder, b.name)))).toBe(true);
    expect(reopened.getFile(other, doc)).toEqual(bytes);
    expect(() => reopened.putFile(target, "late-after-reopen", bytes)).toThrow("Account is fenced");
  } finally {
    db.close();
    if (delayed) close(delayed);
    if (reopened) close(reopened);
    else close(store);
    rmSync(root, { recursive: true, force: true });
  }
});

test("file cleanup leaves a differently rooted reference to the same normalized blob intact", () => {
  const root = mkdtempSync(join(tmpdir(), "weft-account-purge-shared-"));
  const path = join(root, "relay.db");
  const store = new CloudStore(path);
  const db = new Database(path);
  try {
    seed(store, target);
    seed(store, other);
    const own = store.getFileRef(target, doc)!.path;
    const neighbor = store.getFileRef(other, doc)!.path;
    db.run("UPDATE files SET path=? WHERE user_id=?", ["old-host\\relay.db-files\\" + basename(own), other]);
    store.stageAccountPurge(target);
    expect(store.drainAccountPurge(target)).toEqual({ removed: 1, remaining: 1 });
    expect(store.getFile(other, doc)).toEqual(bytes);
    expect(existsSync(own)).toBe(true);
    db.run("UPDATE files SET path=? WHERE user_id=?", [neighbor, other]);
    expect(store.drainAccountPurge(target)).toEqual({ removed: 1, remaining: 0 });
    expect(existsSync(own)).toBe(false);
    expect(existsSync(neighbor)).toBe(true);
  } finally {
    db.close();
    close(store);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a device-authorized source upload waiting on its body cannot write after the fence", async () => {
  const root = mkdtempSync(join(tmpdir(), "weft-account-purge-http-"));
  const path = join(root, "relay.db");
  const relay = startCloud({ port: 0, db: path });
  let admit!: () => void;
  const authenticated = new Promise<void>(resolve => { admit = resolve; });
  const lookup = relay.store.userForDeviceToken.bind(relay.store);
  const spying = spyOn(relay.store, "userForDeviceToken").mockImplementation(token => {
    const user = lookup(token);
    if (user === target) admit();
    return user;
  });
  const request = new AbortController();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let upload: Promise<Response> | undefined;
  try {
    seed(relay.store, target);
    seed(relay.store, other);
    const token = relay.store.mintDeviceToken(target, "Upload device");
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    upload = fetch(`http://127.0.0.1:${relay.port}/api/documents/late-upload/file`, {
      method: "PUT", headers: { "x-device-token": token }, body, signal: request.signal,
    });
    stream.enqueue(bytes);
    await Promise.race([
      authenticated,
      upload.then(() => { throw new Error("Upload completed before its authenticated body was released"); }),
    ]);
    relay.store.stageAccountPurge(target);
    stream.close();
    expect((await upload).ok).toBe(false);
    expect(relay.store.getFileRef(target, "late-upload")).toBeNull();
    expect(relay.store.drainAccountPurge(target)).toEqual({ removed: 2, remaining: 0 });
    expect(readdirSync(path + "-files").sort()).toEqual(["snapshots", basename(relay.store.getFileRef(other, doc)!.path)].sort());
  } finally {
    request.abort();
    if (upload) await upload.catch(() => {});
    spying.mockRestore();
    relay.stop();
    close(relay.store);
    rmSync(root, { recursive: true, force: true });
  }
});

const receiptTables = {
  page_op_batch_receipts: "batch_id TEXT NOT NULL, request_hash TEXT NOT NULL, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, PRIMARY KEY (user_id, doc, page, batch_id)",
  page_snapshot_receipts: "publication_id TEXT NOT NULL, request_hash TEXT NOT NULL, base_seq INTEGER NOT NULL, seq INTEGER NOT NULL, merged INTEGER NOT NULL, PRIMARY KEY (user_id, doc, page, publication_id)",
} as const;

test("purge handles guarded-save migration, including orphan receipts and a peer with colliding IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "weft-account-receipts-"));
  const path = join(root, "relay.db");
  const original = new CloudStore(path);
  const db = new Database(path);
  try {
    for (const [table, definition] of Object.entries(receiptTables)) {
      db.run(`CREATE TABLE IF NOT EXISTS ${table} (
        user_id TEXT NOT NULL, doc TEXT NOT NULL, page TEXT NOT NULL, ${definition}
      ) WITHOUT ROWID`);
      for (const user of [target, other]) {
        const values = [user, doc, page, "id", "hash", 1, 1, ...(table === "page_snapshot_receipts" ? [0] : [])];
        db.run(`INSERT INTO ${table} VALUES (${values.map(() => "?").join(",")})`, values);
      }
    }
    // Run against the already-open relay rather than relying on restart.
    const names = Object.keys(receiptTables);
    expect(planRelayAccountPurge(db, target).rows.filter(row => names.includes(row.table)))
      .toEqual(names.map(table => ({ table, count: 1 })));
    original.stageAccountPurge(target);
    for (const table of names) {
      expect(db.query(`SELECT user_id FROM ${table}`).all()).toEqual([{ user_id: other }]);
      expect(() => db.run(`UPDATE ${table} SET user_id=? WHERE user_id=?`, [target, other]))
        .toThrow("Account is fenced");
      expect(() => db.run(`INSERT INTO ${table} SELECT ?,doc,page,${table === "page_snapshot_receipts"
        ? "publication_id,request_hash,base_seq,seq,merged" : "batch_id,request_hash,first_seq,last_seq"}
        FROM ${table} WHERE user_id=?`, [target, other])).toThrow("Account is fenced");
    }
  } finally {
    db.close();
    close(original);
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to erase against a receipt table with an unreviewed schema", () => {
  const root = mkdtempSync(join(tmpdir(), "weft-account-receipt-schema-"));
  const store = new CloudStore(join(root, "relay.db"));
  const db = connection(store);
  try {
    db.run(`CREATE TABLE IF NOT EXISTS page_op_batch_receipts (
      user_id TEXT NOT NULL, doc TEXT NOT NULL, page TEXT NOT NULL,
      ${receiptTables.page_op_batch_receipts}
    ) WITHOUT ROWID`);
    db.run("ALTER TABLE page_op_batch_receipts ADD COLUMN unexpected TEXT");
    expect(() => store.stageAccountPurge(target)).toThrow("Relay receipt schema changed");
    expect(store.isAccountFenced(target)).toBe(false);
  } finally {
    close(store);
    rmSync(root, { recursive: true, force: true });
  }
});
