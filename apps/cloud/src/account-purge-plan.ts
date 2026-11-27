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
const REQUIRED_TABLES = [...ACCOUNT_PURGE_ORDER, "config"];
const TABLES = new Set<string>([...REQUIRED_TABLES, "account_purge_fences", "account_purge_files"]);

interface RelayAccountPurgePlan {
  rows: ReadonlyArray<{ table: typeof ACCOUNT_PURGE_ORDER[number]; count: number }>;
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

    const rows = ACCOUNT_PURGE_ORDER.map(table => ({
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
