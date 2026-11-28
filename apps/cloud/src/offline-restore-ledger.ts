/** Offline prototype. Not a production migration or deletion endpoint. */
import { Database } from "bun:sqlite";
import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdtempSync, openSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { drainAccountPurge, initAccountPurge, stageAccountPurge } from "./account-purge";

export const RESTORE_LEDGER_KEY = "restore-deletion-ledger-id";
const inside = (path: string, tree: string) => {
  const rel = relative(tree, path);
  return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
};
function syncPath(path: string) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function checkTree(path: string, sync = false) {
  const stat = lstatSync(path);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error("Restore tree contains a non-regular path");
  if (stat.isDirectory()) for (const child of readdirSync(path)) checkTree(join(path, child), sync);
  if (sync) syncPath(path);
}

/** Provision explicitly, never called by restore. Database path is external to relay backups. */
export function provisionLedger(path: string, deployment: string) {
  if (!deployment || existsSync(path)) throw new Error("A new external ledger is required");
  // Create with restrictive permissions before letting SQLite initialize it.
  closeSync(openSync(path, "wx", 0o600));
  const ledger = new Database(path, { readwrite: true });
  try {
    ledger.run("PRAGMA synchronous=FULL");
    ledger.transaction(() => {
      ledger.run("CREATE TABLE installation (id TEXT PRIMARY KEY)");
      ledger.run("CREATE TABLE deletion_intents (seq INTEGER PRIMARY KEY, user_id TEXT NOT NULL UNIQUE)");
      ledger.run("INSERT INTO installation VALUES (?)", [deployment]);
    }).immediate();
    syncPath(dirname(path));
  } finally { ledger.close(); }
}

/** Acknowledge nothing until intent commits on the separate volume. */
export function recordDeletion(path: string, deployment: string, user: string) {
  if (!user || !lstatSync(path).isFile()) throw new Error("An existing external ledger is required");
  const ledger = new Database(path, { readwrite: true, create: false });
  try {
    ledger.run("PRAGMA synchronous=FULL");
    return ledger.transaction(() => {
      if (ledger.query<{ id: string }, string[]>("SELECT id FROM installation").get()?.id !== deployment) {
        throw new Error("Wrong ledger identity");
      }
      ledger.run("INSERT INTO deletion_intents(user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING", [user]);
      return ledger.query<{ seq: number }, [string]>("SELECT seq FROM deletion_intents WHERE user_id=?").get(user)!.seq;
    }).immediate();
  } finally { ledger.close(); }
}

/** Caller must quiesce the previous primary and independently supply the latest trusted generation. */
/**
 * Unwired. Do not start a listener until this offline step succeeds. A
 * replacement must own the deployment, including the external ledger, and
 * know its latest trusted generation independently of the chosen archive.
 */
export function restoreWithLedger(options: {
  archive: string; finalDir: string; ledger: string; deployment: string; minimumGeneration: number;
}) {
  const { finalDir, deployment, minimumGeneration } = options;
  if (!deployment || !Number.isSafeInteger(minimumGeneration) || minimumGeneration < 0 || existsSync(finalDir)) {
    throw new Error("Restore requires identity, trusted generation and a fresh destination");
  }
  const archive = realpathSync(options.archive);
  const parent = realpathSync(dirname(finalDir));
  if (!lstatSync(options.ledger, { throwIfNoEntry: false })?.isFile()) throw new Error("An existing external ledger is required");
  const ledgerPath = realpathSync(options.ledger);
  if (inside(ledgerPath, archive) || inside(ledgerPath, finalDir)) throw new Error("Ledger must be outside the restore image");
  const staging = mkdtempSync(join(parent, ".weft-restore-"));
  let ledger: Database | undefined;
  const path = join(staging, "relay.db");
  try {
    // External ledger reads are one SQLite snapshot. No live primary should exist during restore.
    const external = new Database(ledgerPath, { readonly: true });
    ledger = external;
    const intents = external.transaction(() => {
      if (external.query<{ id: string }, string[]>("SELECT id FROM installation").get()?.id !== deployment) {
        throw new Error("Wrong ledger identity");
      }
      const items = external.query<{ seq: number; user_id: string }, []>("SELECT seq,user_id FROM deletion_intents ORDER BY seq").all();
      if (items.length < minimumGeneration || items.some(({ seq, user_id }, i) => seq !== i + 1 || !user_id)) {
        throw new Error("Ledger is stale or malformed");
      }
      return items;
    })();
    const archiveDb = join(archive, "weft.db"), files = join(archive, "files");
    checkTree(archiveDb);
    checkTree(files);
    cpSync(archiveDb, path, { errorOnExist: true });
    cpSync(files, path + "-files", { recursive: true, errorOnExist: true });
    const db = new Database(path, { readwrite: true, create: false });
    try {
      if (db.query<{ value: string }, [string]>("SELECT value FROM config WHERE key=?").get(RESTORE_LEDGER_KEY)?.value !== deployment) {
        throw new Error("Wrong archive identity");
      }
      initAccountPurge(db);
      const approved = new Set(intents.map(row => row.user_id));
      for (const { user_id } of db.query<{ user_id: string }, []>("SELECT user_id FROM account_purge_fences").all()) {
        if (!approved.has(user_id)) throw new Error("Archive fence is absent from the external ledger");
      }
      for (const { user_id } of intents) {
        stageAccountPurge(db, user_id);
        for (;;) {
          const { removed, remaining } = drainAccountPurge(db, path + "-files", user_id);
          if (!remaining) break;
          if (!removed) throw new Error("Restore cannot finish a recorded deletion; shared or unsafe file");
        }
      }
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }
    checkTree(staging, true);
    if (existsSync(finalDir)) throw new Error("Restore destination appeared during validation");
    renameSync(staging, finalDir);
    syncPath(parent);
    return join(finalDir, "relay.db");
  } finally {
    ledger?.close();
    rmSync(staging, { recursive: true, force: true });
  }
}
