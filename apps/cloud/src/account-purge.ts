import type { Database } from "bun:sqlite";
import { closeSync, fsyncSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_PURGE_ORDER, accountReceiptTables, planRelayAccountPurge } from "./account-purge-plan";

type BlobKey = { folder: "" | "snapshots"; name: string };

function installAccountWriteFence(db: Database, table: string): void {
  for (const event of ["INSERT", "UPDATE"] as const) {
    db.run(`CREATE TRIGGER IF NOT EXISTS account_fence_${table}_${event}
      BEFORE ${event} ON ${table}
      WHEN EXISTS(SELECT 1 FROM account_purge_fences WHERE user_id=NEW.user_id)
      BEGIN SELECT RAISE(ABORT, 'Account is fenced'); END`);
  }
}

export function initAccountPurge(db: Database): void {
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS account_purge_fences (
      user_id TEXT PRIMARY KEY, fenced_at INTEGER NOT NULL
    ) WITHOUT ROWID`);
    db.run(`CREATE TABLE IF NOT EXISTS account_purge_files (
      user_id TEXT NOT NULL, folder TEXT NOT NULL CHECK(folder IN ('', 'snapshots')),
      name TEXT NOT NULL, PRIMARY KEY(user_id, folder, name)
    ) WITHOUT ROWID`);
    db.run(`CREATE TABLE IF NOT EXISTS account_manual_deletions (
      user_id TEXT PRIMARY KEY, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER
    ) WITHOUT ROWID`);
    db.run("CREATE INDEX IF NOT EXISTS account_manual_deletions_due ON account_manual_deletions(due_at) WHERE completed_at IS NULL");
    // Authoritative admission even for body reads that started before the
    // fence was written. Device tokens/configuration alone cannot recreate it.
    for (const table of [...ACCOUNT_PURGE_ORDER, ...accountReceiptTables(db)]) {
      installAccountWriteFence(db, table);
    }
  }).immediate();
}

export function isAccountFenced(db: Database, userId: string): boolean {
  return db.query("SELECT 1 FROM account_purge_fences WHERE user_id=?").get(userId) !== null;
}

/** External writes must check the same fence while holding the writer lock,
 * before writing any bytes. SQL-only writes are protected by the triggers. */
export function withAccountBlobWrite<T>(db: Database, userId: string, write: () => T): T {
  const guarded = () => {
    if (isAccountFenced(db, userId)) throw new Error("Account is fenced");
    return write();
  };
  // Existing surrounding CloudStore publication already owns the writer lock.
  return db.inTransaction ? guarded() : db.transaction(guarded).immediate();
}

export function stageAccountPurge(db: Database, userId: string, manual = false): void {
  durableAccountWrite(db, () => {
    if (!isAccountFenced(db, userId)) {
      const plan = planRelayAccountPurge(db, userId);
      const record = db.query("INSERT OR IGNORE INTO account_purge_files VALUES (?,?,?)");
      for (const { folder, name } of plan.blobs) record.run(userId, folder, name);
      for (const { table } of plan.rows) {
        // A compatible migration may have run since this connection opened.
        installAccountWriteFence(db, table);
        db.run(`DELETE FROM ${table} WHERE user_id=?`, [userId]);
      }
      // Derived trigger rows must be removed before the fence starts blocking writes.
      db.run("INSERT INTO account_purge_fences VALUES (?,?)", [userId, Date.now()]);
    }
    // This marker is written ONLY by the verified, explicit manual route.
    // Its commit and the fence must survive or roll back together.
    if (manual) db.run("INSERT OR IGNORE INTO account_manual_deletions (user_id,due_at) VALUES (?,?)", [userId, Date.now()]);
  });
}

export function durableAccountWrite(db: Database, change: () => void): void {
  if (db.inTransaction) throw new Error("Account purge requires its own writer transaction");
  // The normal relay connection uses WAL synchronous=NORMAL. A successful
  // fence/queue write must not roll back after a subsequent permanent unlink
  // on power loss. FULL synchronizes the WAL commit before we return.
  const sync = db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()!.synchronous;
  if (sync < 2) db.run("PRAGMA synchronous=FULL");
  try {
    db.transaction(change).immediate();
  } finally {
    if (sync < 2) db.run(sync === 0 ? "PRAGMA synchronous=OFF" : "PRAGMA synchronous=NORMAL");
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function removeTrackedBlob(filesDir: string, key: BlobKey): void {
  if (key.name.length !== 64 || /[^0-9a-f]/.test(key.name) || (key.folder !== "" && key.folder !== "snapshots")) {
    throw new Error("Invalid queued relay blob key");
  }
  const folder = join(filesDir, key.folder);
  // unlink does not follow a symlink at the file itself. Never traverse a
  // symlink at either managed blob directory. Missing directories need manual
  // inspection; a missing file in its existing directory is a safe replay.
  if (!lstatSync(filesDir).isDirectory() ||
      (key.folder && !lstatSync(folder).isDirectory())) {
    throw new Error("Invalid relay blob directory");
  }
  const fd = openSync(folder, "r");
  try {
    try {
      unlinkSync(join(folder, key.name));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    // Do not retire the queued key until its absence is synced to disk.
    // Unsupported fsync fails closed and leaves work available for retry.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Retry a bounded batch. Only tracked blobs are covered. This is not a
 * completion receipt for old backups or for unindexed legacy orphans. */
export function drainAccountPurge(db: Database, filesDir: string, userId: string): {
  removed: number;
  remaining: number;
} {
  if (db.inTransaction) throw new Error("Account purge requires its own writer transaction");
  return db.transaction(() => {
    if (!isAccountFenced(db, userId)) throw new Error("Account is not fenced");
    // Restored rows can store a different absolute path for the same
    // digest. Filter shared refs before LIMIT so one stuck batch cannot
    // starve cleanup of unrelated keys later in the queue.
    const files = db.query<BlobKey, [string]>(`
      SELECT q.folder,q.name FROM account_purge_files q WHERE q.user_id=?
      AND NOT EXISTS (SELECT 1 FROM files f
        WHERE q.folder='' AND substr(f.path,-64)=q.name)
      AND NOT EXISTS (SELECT 1 FROM page_snapshots s
        WHERE q.folder='snapshots' AND substr(s.path,-64)=q.name)
      ORDER BY q.folder,q.name LIMIT 64
    `).all(userId);
    let removed = 0;
    for (const key of files) {
      removeTrackedBlob(filesDir, key);
      db.run("DELETE FROM account_purge_files WHERE user_id=? AND folder=? AND name=?", [
        userId, key.folder, key.name,
      ]);
      removed++;
    }
    const remaining = db.query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM account_purge_files WHERE user_id=?",
    ).get(userId)!.n;
    return { removed, remaining };
  }).immediate();
}
