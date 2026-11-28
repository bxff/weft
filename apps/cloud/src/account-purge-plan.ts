import type { Database } from "bun:sqlite";
import { win32 } from "node:path";

// Dependent delete triggers run before their derived metadata is cleared.
// In particular asset/overlay/snapshot deletes recreate recovery_epochs.
export const ACCOUNT_PURGE_ORDER = [
  "device_tokens", "api_keys", "device_doc_manifests", "device_excluded_present",
  "sync_exclusions", "web_opens", "documents", "failure_reports", "changes",
  "templates", "thumbnails", "overlays", "assets", "pages", "page_floors",
  "page_ops", "page_snapshots", "files", "user_quotas",
  "recovery_imports", "recovery_epochs", "user_usage",
] as const;
// Guarded notebook saves may add these tables even when disabled at runtime.
const RECEIPT_TABLES = {
  page_op_batch_receipts: ["batch_id", "first_seq", "last_seq"],
  page_snapshot_receipts: ["publication_id", "base_seq", "seq", "merged"],
} as const;
type ReceiptTable = keyof typeof RECEIPT_TABLES;
const RECEIPT_NAMES = Object.keys(RECEIPT_TABLES) as ReceiptTable[];

export function accountReceiptTables(db: Database): ReceiptTable[] {
  return RECEIPT_NAMES.filter(table => {
    const info = db.query<{ type: string; wr: number }, [string]>(
      "SELECT type, wr FROM pragma_table_list WHERE schema='main' AND name=?",
    ).get(table);
    if (!info) return false;
    const [id, ...seqs] = RECEIPT_TABLES[table];
    const expected = ["user_id", "doc", "page", id, "request_hash", ...seqs];
    const columns = db.query<{
      name: string; type: string; pk: number; nn: number; hidden: number; dflt_value: string | null;
    }, [string]>(
      `SELECT name, type, pk, "notnull" AS nn, hidden, dflt_value FROM pragma_table_xinfo(?, 'main') ORDER BY cid`,
    ).all(table);
    if (info.type !== "table" || !info.wr || columns.length !== expected.length || columns.some((col, i) =>
      col.name !== expected[i] || col.type !== (i < 5 ? "TEXT" : "INTEGER") ||
      col.pk !== (i < 4 ? i + 1 : 0) || col.nn !== 1 || col.hidden !== 0 || col.dflt_value !== null
    ) || db.query("SELECT 1 FROM pragma_foreign_key_list(?, 'main')").get(table)) {
      throw new Error("Relay receipt schema changed; review account purge inventory");
    }
    return true;
  });
}

const REQUIRED_TABLES = [...ACCOUNT_PURGE_ORDER, "config"];
const TABLES = new Set<string>([...REQUIRED_TABLES, ...RECEIPT_NAMES, "account_purge_fences", "account_purge_files", "account_manual_deletions"]);

interface RelayAccountPurgePlan {
  rows: ReadonlyArray<{ table: typeof ACCOUNT_PURGE_ORDER[number] | ReceiptTable; count: number }>;
  blobs: ReadonlyArray<{ folder: "" | "snapshots"; name: string }>;
}

/** Read-only account inventory. A plan alone is never authorization to delete.
 * Rebuild it under the write fence when implementing an actual purge worker.
 * Blob keys are relative to this relay's data directory, never stored paths. */
export function planRelayAccountPurge(db: Database, userId: string): RelayAccountPurgePlan {
  if (userId.length === 0) throw new Error("Account ID is required");
  return db.transaction(() => {
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'",
    ).all().map(({ name }) => name);
    // Require explicit ownership review for migrations, including tables
    // whose account keys do not happen to be named user_id.
    if (REQUIRED_TABLES.some(name => !tables.includes(name)) || tables.some(name => !TABLES.has(name))) {
      throw new Error("Relay schema changed; review account purge inventory");
    }

    // Run after parent page history so trigger-owned receipts go first, then
    // explicitly sweep orphan receipts whose page stream is already absent.
    const rows = [...ACCOUNT_PURGE_ORDER, ...accountReceiptTables(db)].map(table => ({
      table,
      count: db.query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`,
      ).get(userId)!.count,
    }));
    const blobs = db.query<{ folder: "" | "snapshots"; path: string }, [string]>(
      `SELECT '' AS folder, path FROM files WHERE user_id = ?1
       UNION ALL SELECT 'snapshots', path FROM page_snapshots WHERE user_id = ?1`,
    ).all(userId).map(({ folder, path }) => {
      const name = win32.basename(path);
      if (name.length !== 64 || /[^0-9a-f]/.test(name)) throw new Error("Invalid stored relay blob name");
      return { folder, name };
    });
    return { rows, blobs };
  })();
}
