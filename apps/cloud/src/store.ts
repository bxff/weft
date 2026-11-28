/**
 * Cloud store: SQLite, per-user namespaces, CAS revisions identical to
 * rmsyncd (sha256 of bytes; missing page == empty revision '').
 */

import { Database } from "bun:sqlite";
import { publishBackup } from "./backup";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  openSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type { RecoveryImport } from "./recovery-import";
import { RmDocument, RootTextAuthorConflict } from "@weft/rm-format";
import {
  reconstructRm,
  contentBeyond,
  deviceLinesReproduced,
  rekeyCloneCollisions,
  diffToOps,
  gateTombstonesByBase,
  deviceRemovedTombstones,
  mergeForSnapshot,
  mergeOverlayDocuments,
  decodeSnapshot,
  encodeSnapshot,
  decodeOp,
  encodeOp,
  foldOverlayOps,
  type Op,
  type OverlayDocument,
  type SnapshotBatch,
} from "@weft/sync-engine";

/** Keep FULL enabled through the caller's synchronous, top-level commit. */
function withFullDurability<T>(db: Database, publish: () => T): T {
  if (db.inTransaction) throw new Error("Durable publication requires its own transaction");
  const previous = db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()!.synchronous;
  db.run("PRAGMA synchronous = FULL");
  try {
    return publish();
  } finally {
    db.run(`PRAGMA synchronous = ${previous}`);
  }
}

/** Author naming author-table index 1 when seeding an empty reconstructed doc
 *  for the device bridge; real ink ops carry their own authors. */
const DEVICE_BRIDGE_AUTHOR = "c10d0000-0000-4000-a000-000000000001";

/** Author of the no-op marker op a revert appends. The marker advances the op
 *  head so the revert is a distinct timeline point superseding (never deleting)
 *  earlier ops; materializers filter it by op type, so only the seq advances. */
const REVERT_AUTHOR = "c10d0000-0000-4000-a000-000000000002";

/** The op-log marker a revert appends. Opaque to both materializers (unknown op
 *  type, filtered out), so it only occupies a seq. `toSeq` records the restored
 *  target. */
function revertMarkerOp(toSeq: number): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ op: "revert-marker", toSeq }),
  );
}

export interface CloudPage {
  bytes: Uint8Array;
  revision: string;
}

export interface ChangeRow {
  seq: number;
  doc: string;
  page: string;
  revision: string;
  originClientId: string | null;
}

/** Max ops returned per opsSince() page; callers page using the head cursor. */
export const OPS_PAGE_LIMIT = 5000;

/** Recent snapshots retained per page (older pruned on each putSnapshot to
 *  bound disk/quota; leaves headroom for history/bootstrap). */
export const SNAPSHOT_KEEP = 10;

// ----- log compaction / retention -----
// Compaction folds ops <= a head H into a fresh checkpoint pinned at H, so
// reconstruct(latest snapshot + opsSince) reads a small tail, not the whole log.
// Two knobs so retention can be enabled later by config, no rewrite:
//  - RETENTION_KEEP_ALL (default true): checkpoint but never delete page_ops;
//    full history retained so history/time-travel/revert reach the oldest state.
//  - RETENTION_KEEP_RECENT_OPS: the window compact() keeps once truncation is on
//    (deletes ops strictly older than max(0, checkpointHead - window)).
// Truncation is safe: (1) a persisted per-page truncation floor
// (page_floors.floor_seq) is set atomically with the DELETE, and /ops answers
// 410 to a cursor below it so a gapped log never silently diverges; (2) compact
// pins a boundary checkpoint at the floor before deleting, keeping
// stateAt/revertTo byte-correct for every target >= floor (below refuses with
// BelowFloorError). Trigger: a per-page un-compacted op-count threshold
// (COMPACT_EVERY_N_OPS) checked in appendOps; compact() is also callable directly.
export const RETENTION_KEEP_ALL = true;

/** Ops kept behind the compaction head when truncation is enabled. Ops strictly
 *  older are eligible for deletion. Enabling truncation refuses time-travel/revert
 *  below the resulting floor (BelowFloorError / HTTP 410); at/above stays
 *  byte-identical. */
export const RETENTION_KEEP_RECENT_OPS = 2000;

/**
 * A time-travel/revert target below the page's truncation floor: the ops to
 * reconstruct it were deleted by retention, so a reconstruct would be wrong.
 * The /at and /revert routes map this to HTTP 410 { error, floorSeq }.
 */
export class BelowFloorError extends Error {
  constructor(
    readonly floorSeq: number,
    target: number,
  ) {
    super(
      `op seq ${target} is below the truncation floor ${floorSeq} (ops truncated by retention)`,
    );
  }
}

/** A known checkpoint cannot be read safely. */
export class CheckpointUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("required checkpoint is unavailable", { cause });
  }
}

/** Auto-compact a page once it has this many un-compacted ops of its own (seq >
 *  its latest snapshot's op_seq). Per-page count, independent of the store-wide
 *  page_ops autoincrement. 0 disables the auto trigger (compact() stays callable). */
export const COMPACT_EVERY_N_OPS = 1000;

/** The device-facing revision marker. One producer: the daemon's is_op_mode()
 *  keys off the exact "ops:" prefix and the reconcile sweep compares these
 *  strings verbatim, so never inline the format. */
function opMarker(opSeq: number, snapSeq: number): string {
  return `ops:${opSeq}+${snapSeq}`;
}

function sha256hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

export interface SnapshotPublication {
  id: string;
  baseSeq: number;
}

export class SnapshotUnavailable extends Error {
  constructor() { super("Current page checkpoint is unavailable"); }
}

type SnapshotPublicationResult<T> =
  | { kind: "accepted"; seq: number; merged: boolean; duplicate: boolean }
  | { kind: "stale"; currentSeq: number }
  | { kind: "reused" }
  | { kind: "blocked"; response: T };

/**
 * The two storage classes. `created` is the user's own irreplaceable output
 * (pages, ops, snapshots, overlays, assets, thumbnails, templates). `sources`
 * is replaceable document source files (PDF/EPUB) the tablet still holds: large,
 * cacheable, the only class that can be tablet-only.
 */
export type StorageClass = "created" | "sources";

/** [table, size column, storage class] for the usage triggers + backfill.
 *  `size` means the table stores a byte count; anything else is measured with
 *  length(). Every blob-bearing table must be listed or its bytes are free. */
const USAGE_TABLES: [string, string, StorageClass][] = [
  ["pages", "bytes", "created"],
  ["overlays", "json", "created"],
  ["assets", "bytes", "created"],
  ["thumbnails", "bytes", "created"],
  ["templates", "bytes", "created"],
  ["files", "size", "sources"],
  // op-log + snapshots count toward quota too; ops reclaimed by compaction,
  // snapshots by prune.
  ["page_ops", "op", "created"],
  ["page_snapshots", "size", "created"],
];

export class CloudStore {
  private db: Database;
  private stagedPageFiles: string[] | null = null;
  private retiredPageFiles: string[] | null = null;
  /** Directory for large blobs (document source files) kept off the DB. */
  private filesDir: string;
  constructor(path = ":memory:") {
    this.db = new Database(path);
    // Large source files (PDF/EPUB->PDF, tens of MB) live on disk, not SQLite:
    // keeps the DB small and lets reads stream (HTTP Range) instead of buffering.
    // A :memory: DB (tests) gets a throwaway temp dir.
    this.filesDir =
      path === ":memory:"
        ? mkdtempSync(join(tmpdir(), "weft-files-"))
        : join(dirname(resolve(path)), `${basename(path)}-files`);
    mkdirSync(this.filesDir, { recursive: true });
    // Required for the usage counters: `files` is written INSERT OR REPLACE, and
    // SQLite fires a replaced row's AFTER DELETE trigger only with
    // recursive_triggers ON (defaults OFF). Without it a source re-push runs
    // AFTER INSERT but not AFTER DELETE, so the sources meter drifts up unbounded.
    this.db.run("PRAGMA recursive_triggers = ON");
    // Durability/concurrency for a file-backed DB (no-ops on :memory:).
    if (path !== ":memory:") {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA synchronous = NORMAL");
      this.db.run("PRAGMA busy_timeout = 5000");
      // ~64MB page cache (negative = KiB) + 256MB mmap for zero-copy reads.
      this.db.run("PRAGMA cache_size = -64000");
      this.db.run("PRAGMA mmap_size = 268435456");
    }
    this.db.run(`
            CREATE TABLE IF NOT EXISTS pages (
                user_id TEXT NOT NULL, doc TEXT NOT NULL, page TEXT NOT NULL,
                bytes BLOB NOT NULL, revision TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, doc, page)
            );
            CREATE TABLE IF NOT EXISTS overlays (
                user_id TEXT NOT NULL, doc TEXT NOT NULL, page TEXT NOT NULL,
                json TEXT NOT NULL,
                PRIMARY KEY (user_id, doc, page)
            );
            CREATE TABLE IF NOT EXISTS assets (
                user_id TEXT NOT NULL, doc TEXT NOT NULL, page TEXT NOT NULL,
                file TEXT NOT NULL, bytes BLOB NOT NULL, etag TEXT,
                PRIMARY KEY (user_id, doc, page, file)
            );
            CREATE TABLE IF NOT EXISTS recovery_epochs (
                user_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS recovery_imports (
                user_id TEXT PRIMARY KEY, digest TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS thumbnails (
                user_id TEXT NOT NULL, doc TEXT NOT NULL, page TEXT NOT NULL,
                bytes BLOB NOT NULL,
                etag TEXT,
                PRIMARY KEY (user_id, doc, page)
            );
            CREATE TABLE IF NOT EXISTS files (
                user_id TEXT NOT NULL, doc TEXT NOT NULL,
                path TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL,
                etag TEXT,
                PRIMARY KEY (user_id, doc)
            );
            CREATE TABLE IF NOT EXISTS templates (
                user_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL,
                PRIMARY KEY (user_id, name)
            );
            CREATE TABLE IF NOT EXISTS documents (
                user_id TEXT NOT NULL PRIMARY KEY,
                json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS device_tokens (
                token TEXT PRIMARY KEY,
                id TEXT,
                user_id TEXT NOT NULL,
                label TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_used_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                key TEXT NOT NULL UNIQUE,
                user_id TEXT NOT NULL,
                label TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_used_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys(user_id);
            CREATE TABLE IF NOT EXISTS changes (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL, doc TEXT NOT NULL, page TEXT NOT NULL,
                revision TEXT NOT NULL, origin_client TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS failure_reports (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                tag TEXT NOT NULL,
                message TEXT NOT NULL,
                app_version TEXT NOT NULL,
                source TEXT NOT NULL,
                doc_hash TEXT,
                page_hash TEXT,
                context TEXT,
                occurred_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS failure_reports_user ON failure_reports(user_id, created_at);
            -- op + snapshot channels. The cloud is an opaque relay: op/snapshot
            -- bytes are never parsed here.
            CREATE TABLE IF NOT EXISTS page_ops (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL, doc TEXT NOT NULL, page TEXT NOT NULL,
                op BLOB NOT NULL, author TEXT, ts INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS page_ops_page ON page_ops(user_id, doc, page, seq);
            CREATE TABLE IF NOT EXISTS page_op_batch_receipts (
                user_id TEXT NOT NULL, doc TEXT NOT NULL, page TEXT NOT NULL,
                batch_id TEXT NOT NULL, request_hash TEXT NOT NULL,
                first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL,
                PRIMARY KEY (user_id, doc, page, batch_id)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS page_snapshots (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL, doc TEXT NOT NULL, page TEXT NOT NULL,
                path TEXT NOT NULL, size INTEGER NOT NULL, ts INTEGER NOT NULL,
                -- the page_ops head folded into this snapshot; reconstruct =
                -- snapshot bytes + opsSince(op_seq). 0 = a pre-op-log snapshot
                -- (replay every op).
                op_seq INTEGER NOT NULL DEFAULT 0,
                -- 1 = a revert head-rewrite: pinned at the current head, its bytes
                -- are a past state superseding intervening ops without deleting
                -- them. Live and time-travel treat it as authoritative for targets
                -- at/after its op_seq (newest-snapshot rule), so stateAt(head)==live
                -- after a revert; targets before op_seq exclude it and raw-replay.
                -- Also exempts revert markers from SNAPSHOT_KEEP pruning.
                revert INTEGER NOT NULL DEFAULT 0,
                sha256 TEXT
            );
            CREATE INDEX IF NOT EXISTS page_snapshots_page ON page_snapshots(user_id, doc, page, seq);
            -- A receipt must outlive snapshot pruning: a browser may restart
            -- and retry an already accepted upload long after it was pruned.
            CREATE TABLE IF NOT EXISTS page_snapshot_receipts (
                user_id TEXT NOT NULL, doc TEXT NOT NULL, page TEXT NOT NULL,
                publication_id TEXT NOT NULL, request_hash TEXT NOT NULL,
                base_seq INTEGER NOT NULL, seq INTEGER NOT NULL, merged INTEGER NOT NULL,
                PRIMARY KEY (user_id, doc, page, publication_id)
            ) WITHOUT ROWID;
            -- Pruning retains a head. Removing the entire snapshot stream
            -- ends the page's lifetime and must also remove its receipts.
            CREATE TRIGGER IF NOT EXISTS page_snapshot_receipts_after_delete
            AFTER DELETE ON page_snapshots WHEN NOT EXISTS (
                SELECT 1 FROM page_snapshots
                WHERE user_id=OLD.user_id AND doc=OLD.doc AND page=OLD.page
            ) BEGIN
                DELETE FROM page_snapshot_receipts
                WHERE user_id=OLD.user_id AND doc=OLD.doc AND page=OLD.page;
            END;
            -- History pruning retains a page stream. Clear append receipts
            -- only when both its ops and its snapshots have been removed.
            CREATE TRIGGER IF NOT EXISTS page_op_batches_after_ops_delete
            AFTER DELETE ON page_ops WHEN NOT EXISTS (
                SELECT 1 FROM page_ops WHERE user_id=OLD.user_id AND doc=OLD.doc AND page=OLD.page
            ) AND NOT EXISTS (
                SELECT 1 FROM page_snapshots WHERE user_id=OLD.user_id AND doc=OLD.doc AND page=OLD.page
            ) BEGIN
                DELETE FROM page_op_batch_receipts
                WHERE user_id=OLD.user_id AND doc=OLD.doc AND page=OLD.page;
            END;
            CREATE TRIGGER IF NOT EXISTS page_op_batches_after_snapshot_delete
            AFTER DELETE ON page_snapshots WHEN NOT EXISTS (
                SELECT 1 FROM page_snapshots WHERE user_id=OLD.user_id AND doc=OLD.doc AND page=OLD.page
            ) AND NOT EXISTS (
                SELECT 1 FROM page_ops WHERE user_id=OLD.user_id AND doc=OLD.doc AND page=OLD.page
            ) BEGIN
                DELETE FROM page_op_batch_receipts
                WHERE user_id=OLD.user_id AND doc=OLD.doc AND page=OLD.page;
            END;
            -- Truncation floor: the highest op seq retention deleted for a page
            -- (absent/0 = nothing truncated). Persisted explicitly, never derived
            -- from MIN(page_ops.seq), which cannot distinguish "truncated below X"
            -- from "the log starts at X".
            CREATE TABLE IF NOT EXISTS page_floors (
                user_id TEXT NOT NULL, doc TEXT NOT NULL, page TEXT NOT NULL,
                floor_seq INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, doc, page)
            );
            -- Multi-tablet doc manifests: the doc ids each device (sha256 of its
            -- token) last reported having. A device's authoritative push may only
            -- delete docs in its manifest; "absent from my tree" from a tablet
            -- that never had the doc means "not synced to me yet", never "deleted".
            CREATE TABLE IF NOT EXISTS device_doc_manifests (
                user_id TEXT NOT NULL, device TEXT NOT NULL, doc TEXT NOT NULL,
                PRIMARY KEY (user_id, device, doc)
            );
            -- Per-user per-class quota overrides (bytes; 0 = explicitly
            -- unlimited; NULL = deployment default WEFT_QUOTA_*_BYTES). Set via
            -- PUT /api/admin/quota.
            CREATE TABLE IF NOT EXISTS user_quotas (
                user_id TEXT NOT NULL PRIMARY KEY,
                created_bytes INTEGER,
                sources_bytes INTEGER
            );
            -- "Last opened on the web" per doc: the daemon folds these into
            -- xochitl .metadata as a max-register so lastOpened means "last opened
            -- anywhere". One row per doc.
            CREATE TABLE IF NOT EXISTS web_opens (
                user_id TEXT NOT NULL, doc TEXT NOT NULL,
                page TEXT NOT NULL, opened_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, doc)
            );
            -- Selective sync: doc/folder ids the user chose to keep off the cloud.
            -- The daemon skips pushing them (and descendants); the server refuses
            -- writes for them as a backstop.
            CREATE TABLE IF NOT EXISTS sync_exclusions (
                user_id TEXT NOT NULL, doc TEXT NOT NULL,
                PRIMARY KEY (user_id, doc)
            );
            -- Which excluded docs each device still physically has (from the
            -- excludedInfo sidecar of its doc-list push). An exclusion row whose
            -- doc no paired device still has is a ghost: deleted on-tablet while
            -- excluded (daemon filters excluded docs, so the deletion is otherwise
            -- invisible), and must be pruned.
            CREATE TABLE IF NOT EXISTS device_excluded_present (
                user_id TEXT NOT NULL, device TEXT NOT NULL, doc TEXT NOT NULL,
                PRIMARY KEY (user_id, device, doc)
            );
        `);
    // Retain each excluded doc's display info: excluding drops it from
    // GET /api/documents (the list the exclusion tree is built from), so without
    // a remembered name/type/parent the doc could never be re-included from the
    // web. Guarded ALTERs add the columns once to an existing DB.
    for (const col of ["name TEXT", "type TEXT", "parent TEXT"]) {
      try {
        this.db.run(`ALTER TABLE sync_exclusions ADD COLUMN ${col}`);
      } catch {
        // column already present
      }
    }
    this.db.run(
      "CREATE INDEX IF NOT EXISTS device_tokens_user ON device_tokens(user_id)",
    );
    if (!(this.db.query<{ name: string }, []>("PRAGMA table_info(assets)").all())
      .some((column) => column.name === "etag")) {
      this.db.run("ALTER TABLE assets ADD COLUMN etag TEXT");
    }
    if (!this.db.query("SELECT 1 FROM pragma_table_info('page_snapshots') WHERE name='sha256'").get()) {
      this.db.run("ALTER TABLE page_snapshots ADD COLUMN sha256 TEXT");
    }

    // Existing change sequence covers normal page writes. Track independent
    // changes transactionally (including DELETE and same-name replacement), so
    // an unchanged recovery sweep does not have to scan a user's library.
    for (const table of ["assets", "overlays", "page_snapshots"]) {
      for (const [event, row] of [["INSERT", "NEW"], ["UPDATE", "NEW"], ["DELETE", "OLD"]]) {
        this.db.run(`
          CREATE TRIGGER IF NOT EXISTS recovery_epoch_${table}_${event}
          AFTER ${event} ON ${table} BEGIN
            INSERT INTO recovery_epochs (user_id, epoch) VALUES (${row}.user_id, 1)
            ON CONFLICT(user_id) DO UPDATE SET epoch=epoch+1;
          END;
        `);
      }
    }
    this.initUsageTracking();
    this.reclaimOrphanSources();
  }

  // ----- per-user storage usage (two classes) -----

  /**
   * Maintain a per-user per-class byte counter in `user_usage` via triggers on
   * the blob tables, so quota checks are O(1) instead of summing every blob per
   * write. Each table feeds one class (USAGE_TABLES): files -> sources, else
   * created. Backfilled once from existing rows. INSERT OR REPLACE fires
   * DELETE+INSERT, so the AFTER triggers stay exact across overwrites.
   */
  private initUsageTracking(): void {
    this.db.run(
      `CREATE TABLE IF NOT EXISTS user_usage (
                user_id TEXT NOT NULL, class TEXT NOT NULL,
                bytes INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, class)
            )`,
    );
    for (const [t, col, cls] of USAGE_TABLES) {
      const ins = col === "size" ? "NEW.size" : `length(NEW.${col})`;
      const del = col === "size" ? "OLD.size" : `length(OLD.${col})`;
      this.db.run(
        `CREATE TRIGGER IF NOT EXISTS ${t}_usage_ai AFTER INSERT ON ${t} BEGIN
                    INSERT INTO user_usage(user_id, class, bytes) VALUES (NEW.user_id, '${cls}', ${ins})
                    ON CONFLICT(user_id, class) DO UPDATE SET bytes = bytes + ${ins};
                END`,
      );
      this.db.run(
        `CREATE TRIGGER IF NOT EXISTS ${t}_usage_ad AFTER DELETE ON ${t} BEGIN
                    UPDATE user_usage SET bytes = max(0, bytes - ${del}) WHERE user_id = OLD.user_id AND class = '${cls}';
                END`,
      );
      // ON CONFLICT DO UPDATE (e.g. putPage) fires an UPDATE, so adjust by the
      // net delta. (INSERT OR REPLACE fires AD+AI and never reaches this.)
      this.db.run(
        `CREATE TRIGGER IF NOT EXISTS ${t}_usage_au AFTER UPDATE ON ${t} BEGIN
                    UPDATE user_usage SET bytes = max(0, bytes - ${del} + ${ins}) WHERE user_id = NEW.user_id AND class = '${cls}';
                END`,
      );
    }
    this.recomputeUsage();
  }

  /** Rebuild every user_usage counter from the actual table sums, healing any
   *  historical drift. Runs once at startup; SUMs are index-backed and cheap. */
  private recomputeUsage(): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM user_usage");
      for (const [t, col, cls] of USAGE_TABLES) {
        const size = col === "size" ? "size" : `length(${col})`;
        this.db.run(
          `INSERT INTO user_usage(user_id, class, bytes)
             SELECT user_id, '${cls}', COALESCE(SUM(${size}), 0) FROM ${t} GROUP BY user_id
           ON CONFLICT(user_id, class) DO UPDATE SET bytes = bytes + excluded.bytes`,
        );
      }
    })();
  }

  /** Bytes a user currently stores in ONE class ('created' = pages, ops,
   *  snapshots, overlays, assets, thumbnails, templates; 'sources' = document
   *  source files). */
  usageBytes(user: string, cls: StorageClass): number {
    const row = this.db
      .query("SELECT bytes FROM user_usage WHERE user_id=? AND class=?")
      .get(user, cls) as { bytes: number } | null;
    return row?.bytes ?? 0;
  }

  /** Bytes a user stores across both classes (admin stats, new-user capacity
   *  check). */
  usageTotal(user: string): number {
    const row = this.db
      .query(
        "SELECT COALESCE(SUM(bytes), 0) AS total FROM user_usage WHERE user_id=?",
      )
      .get(user) as { total: number };
    return row.total;
  }

  /**
   * Per-document storage breakdown. Grouped into created blobs (pages +
   * overlays + assets + thumbnails), op log, snapshots, and the source file
   * (pdf/epub), kept separate because sources have their own quota class and
   * `sourceBytes > 0` is the residency signal (a source-less pdf/epub doc is
   * tablet-only). Descending by total. Per-user items with no doc (templates,
   * failure reports) aren't listed, so the sum can be slightly below the usage
   * counters.
   */
  usageByDoc(user: string): {
    doc: string;
    blobBytes: number;
    opsBytes: number;
    snapshotBytes: number;
    sourceBytes: number;
    totalBytes: number;
  }[] {
    const rows = this.db
      .query<
        { doc: string; blob: number; ops: number; snaps: number; src: number },
        [string, string, string, string, string, string, string]
      >(
        `SELECT doc,
                SUM(CASE WHEN src NOT IN ('ops','snaps','files') THEN n ELSE 0 END) AS blob,
                SUM(CASE WHEN src = 'ops' THEN n ELSE 0 END) AS ops,
                SUM(CASE WHEN src = 'snaps' THEN n ELSE 0 END) AS snaps,
                SUM(CASE WHEN src = 'files' THEN n ELSE 0 END) AS src
         FROM (
            SELECT doc, 'pages' AS src, COALESCE(SUM(LENGTH(bytes)),0) AS n FROM pages WHERE user_id=? GROUP BY doc
            UNION ALL
            SELECT doc, 'overlays', COALESCE(SUM(LENGTH(json)),0) FROM overlays WHERE user_id=? GROUP BY doc
            UNION ALL
            SELECT doc, 'assets', COALESCE(SUM(LENGTH(bytes)),0) FROM assets WHERE user_id=? GROUP BY doc
            UNION ALL
            SELECT doc, 'thumbs', COALESCE(SUM(LENGTH(bytes)),0) FROM thumbnails WHERE user_id=? GROUP BY doc
            UNION ALL
            SELECT doc, 'files', COALESCE(SUM(size),0) FROM files WHERE user_id=? GROUP BY doc
            UNION ALL
            SELECT doc, 'ops', COALESCE(SUM(LENGTH(op)),0) FROM page_ops WHERE user_id=? GROUP BY doc
            UNION ALL
            SELECT doc, 'snaps', COALESCE(SUM(size),0) FROM page_snapshots WHERE user_id=? GROUP BY doc
         )
         GROUP BY doc ORDER BY (blob + ops + snaps + src) DESC`,
      )
      .all(user, user, user, user, user, user, user);
    return rows.map((r) => ({
      doc: r.doc,
      blobBytes: r.blob,
      opsBytes: r.ops,
      snapshotBytes: r.snaps,
      sourceBytes: r.src,
      totalBytes: r.blob + r.ops + r.snaps + r.src,
    }));
  }

  /**
   * User-facing "Clear history" for one page. A truncating compact with a
   * zero-op window raises the persisted floor to just below the head (live
   * bytes stay identical; lagging clients re-bootstrap via 410), then every
   * snapshot pinned below the floor (unreachable by stateAt, revert markers
   * included) is retired in that transaction. Files are removed after commit
   * and usage triggers refund the bytes. No-op for blob pages and pages with no
   * history before the current operation.
   */
  clearPageHistory(
    user: string,
    doc: string,
    page: string,
  ): { opsDeleted: number; snapshotsDeleted: number; floor: number } {
    return this.publishPage(user, doc, page, () => {
      // After a successful clear only the head operation remains. Do not
      // create another checkpoint (and revision) when there is nothing to clear.
      const older = this.db.query(
        "SELECT 1 FROM page_ops WHERE user_id=? AND doc=? AND page=? LIMIT 1 OFFSET 1",
      ).get(user, doc, page);
      const opsDeleted = older
        ? this.compact(user, doc, page, { keepAll: false, keepRecentOps: 0 }).opsTruncated
        : 0;
      const floor = this.truncationFloor(user, doc, page);
      const retired = this.db.query<{ path: string }, [string, string, string, number]>(
        `DELETE FROM page_snapshots
         WHERE user_id=? AND doc=? AND page=? AND op_seq < ? RETURNING path`,
      ).all(user, doc, page, floor);
      for (const row of retired) this.retiredPageFiles!.push(row.path);
      return { opsDeleted, snapshotsDeleted: retired.length, floor };
    });
  }

  // ----- selective sync -----

  getSyncExclusions(user: string): string[] {
    return this.db
      .query<{ doc: string }, [string]>(
        "SELECT doc FROM sync_exclusions WHERE user_id=? ORDER BY doc",
      )
      .all(user)
      .map((r) => r.doc);
  }

  /** Excluded docs WITH their remembered display info, so the settings UI can
   *  render (and re-include) a doc even after the daemon dropped it from the
   *  cloud list. name/type/parent may be null for pre-migration rows. */
  getExcludedDocInfo(
    user: string,
  ): { id: string; name: string | null; type: string | null; parent: string | null }[] {
    return this.db
      .query<
        { doc: string; name: string | null; type: string | null; parent: string | null },
        [string]
      >(
        "SELECT doc, name, type, parent FROM sync_exclusions WHERE user_id=? ORDER BY doc",
      )
      .all(user)
      .map((r) => ({ id: r.doc, name: r.name, type: r.type, parent: r.parent }));
  }

  /** Record which excluded docs this device still has, then prune ghost
   *  exclusion rows: docs no device has (excluded-present or manifest) were
   *  deleted on-tablet while excluded, nothing left to re-include. */
  reconcileExcludedPresence(
    user: string,
    deviceKey: string,
    presentIds: string[],
  ): void {
    this.db.transaction(() => {
      this.db.run(
        "DELETE FROM device_excluded_present WHERE user_id=? AND device=?",
        [user, deviceKey],
      );
      const ins = this.db.query(
        "INSERT OR IGNORE INTO device_excluded_present (user_id, device, doc) VALUES (?,?,?)",
      );
      for (const d of presentIds) ins.run(user, deviceKey, d);
      this.db.run(
        `DELETE FROM sync_exclusions WHERE user_id=?
           AND doc NOT IN (SELECT doc FROM device_excluded_present WHERE user_id=?)
           AND doc NOT IN (SELECT doc FROM device_doc_manifests WHERE user_id=?)`,
        [user, user, user],
      );
    })();
  }

  /** Forget everything keyed to a revoked device: its manifest (deletion
   *  authority) and excluded-present rows, else an unpaired tablet pins ghost
   *  exclusions and phantom deletion authority forever. */
  dropDeviceState(user: string, deviceKey: string): void {
    this.db.transaction(() => {
      this.db.run(
        "DELETE FROM device_doc_manifests WHERE user_id=? AND device=?",
        [user, deviceKey],
      );
      this.db.run(
        "DELETE FROM device_excluded_present WHERE user_id=? AND device=?",
        [user, deviceKey],
      );
    })();
  }

  backfillExclusionInfo(
    user: string,
    infos: { id: string; name: string; type?: string; parent?: string }[],
  ): void {
    if (infos.length === 0) return;
    this.db.transaction(() => {
      for (const i of infos) {
        this.db.run(
          `UPDATE sync_exclusions SET name=?, type=COALESCE(?, type),
                  parent=COALESCE(?, parent)
             WHERE user_id=? AND doc=?`,
          [i.name, i.type ?? null, i.parent ?? null, user, i.id],
        );
      }
    })();
  }

  setSyncExclusions(user: string, docs: string[]): void {
    // Capture each excluded doc's display info now, while it is still in the
    // cloud list, so it survives the daemon dropping it. A doc already excluded
    // (no longer in the list) keeps its previously-stored info.
    const current = new Map<string, { name?: unknown; type?: unknown; parent?: unknown }>();
    try {
      const list = JSON.parse(this.getDocuments(user)) as {
        documents?: { id?: unknown; name?: unknown; type?: unknown; parent?: unknown }[];
      };
      for (const d of list.documents ?? []) {
        if (typeof d.id === "string") current.set(d.id, d);
      }
    } catch {
      // no/garbage list — fall back to remembered info only
    }
    const remembered = new Map(
      this.getExcludedDocInfo(user).map((e) => [e.id, e]),
    );
    const infoFor = (id: string) => {
      const c = current.get(id);
      const r = remembered.get(id);
      return {
        name: (typeof c?.name === "string" ? c.name : null) ?? r?.name ?? null,
        type: (typeof c?.type === "string" ? c.type : null) ?? r?.type ?? null,
        parent:
          (typeof c?.parent === "string" ? c.parent : null) ?? r?.parent ?? null,
      };
    };
    this.db.transaction(() => {
      this.db.run("DELETE FROM sync_exclusions WHERE user_id=?", [user]);
      for (const doc of new Set(docs)) {
        const i = infoFor(doc);
        this.db.run(
          "INSERT INTO sync_exclusions (user_id, doc, name, type, parent) VALUES (?,?,?,?,?)",
          [user, doc, i.name, i.type, i.parent],
        );
      }
    })();
  }

  /**
   * Is this doc excluded from sync, directly or via any ancestor folder in the
   * stored doc tree? (Excluding a folder covers everything under it.)
   * Server-side backstop so a stale daemon cannot leak content.
   */
  isDocExcluded(user: string, doc: string): boolean {
    const excluded = new Set(this.getSyncExclusions(user));
    if (excluded.size === 0) return false;
    if (excluded.has(doc)) return true;
    let parents: Map<string, string>;
    try {
      const list = JSON.parse(this.getDocuments(user)) as {
        documents?: { id?: unknown; parent?: unknown }[];
      };
      parents = new Map(
        (list.documents ?? [])
          .filter((d) => typeof d.id === "string")
          .map((d) => [
            d.id as string,
            typeof d.parent === "string" ? (d.parent as string) : "",
          ]),
      );
    } catch {
      return false;
    }
    const seen = new Set<string>();
    let p = parents.get(doc) ?? "";
    while (p !== "" && p !== "trash" && !seen.has(p)) {
      if (excluded.has(p)) return true;
      seen.add(p);
      p = parents.get(p) ?? "";
    }
    return false;
  }

  /** The doc list with excluded docs (and everything under an excluded folder)
   *  removed: the web view. Filtered server-side so an exclusion reflects
   *  immediately without depending on the daemon re-pushing a filtered list
   *  (which never happens while the tablet is off). One pass over the tree. */
  visibleDocuments(user: string): string {
    const excluded = new Set(this.getSyncExclusions(user));
    const raw = this.getDocuments(user);
    if (excluded.size === 0) return raw;
    let list: { documents?: { id?: unknown; parent?: unknown }[] };
    try {
      list = JSON.parse(raw);
    } catch {
      return raw;
    }
    const docs = (list.documents ?? []).filter(
      (d): d is { id: string; parent?: unknown } => typeof d.id === "string",
    );
    const parents = new Map(
      docs.map((d) => [d.id, typeof d.parent === "string" ? d.parent : ""]),
    );
    const isExcluded = (id: string): boolean => {
      const seen = new Set<string>();
      let p: string | undefined = id;
      while (p && p !== "trash" && !seen.has(p)) {
        if (excluded.has(p)) return true;
        seen.add(p);
        p = parents.get(p);
      }
      return false;
    };
    return JSON.stringify({
      documents: docs.filter((d) => !isExcluded(d.id)),
    });
  }

  /** Every user's stored bytes (both classes), descending — the #59 admin
   *  stats input. */
  usageAllUsers(): { user: string; bytes: number }[] {
    return this.db
      .query<{ user: string; bytes: number }, []>(
        `SELECT user_id AS user, SUM(bytes) AS bytes FROM user_usage
                 GROUP BY user_id ORDER BY bytes DESC`,
      )
      .all();
  }

  /** Bytes stored across ALL users — the #58 capacity-watermark input. Sums
   *  every (user, class) row, so this is the true grand total. */
  totalUsageBytes(): number {
    const row = this.db
      .query("SELECT COALESCE(SUM(bytes), 0) AS total FROM user_usage")
      .get() as { total: number };
    return row.total;
  }

  /** Per-user per-class quota override (bytes; 0 = explicitly unlimited), or
   *  null to use the deployment default (WEFT_QUOTA_*_BYTES). The "request
   *  more space" bump, set via PUT /api/admin/quota without redeploying. */
  userQuotaOverride(user: string, cls: StorageClass): number | null {
    const col = cls === "sources" ? "sources_bytes" : "created_bytes";
    const row = this.db
      .query(`SELECT ${col} AS v FROM user_quotas WHERE user_id=?`)
      .get(user) as { v: number | null } | null;
    return row?.v ?? null;
  }

  /** Set (or clear with null) one class's override; a row with both classes
   *  cleared is removed so "no overrides" stays representable as "no row". */
  setUserQuota(user: string, cls: StorageClass, bytes: number | null): void {
    const col = cls === "sources" ? "sources_bytes" : "created_bytes";
    this.db.run(
      `INSERT INTO user_quotas (user_id, ${col}) VALUES (?,?)
             ON CONFLICT(user_id) DO UPDATE SET ${col}=excluded.${col}`,
      [user, bytes],
    );
    this.db.run(
      "DELETE FROM user_quotas WHERE user_id=? AND created_bytes IS NULL AND sources_bytes IS NULL",
      [user],
    );
  }

  // ----- web opens (STORAGE-PLAN §3: lastOpened = "last opened anywhere") -----

  /** Record that the user opened doc/page on the web just now. Monotonic:
   *  an out-of-order write can never move a doc's open time backwards. */
  recordWebOpen(user: string, doc: string, page: string): void {
    this.db.run(
      `INSERT INTO web_opens (user_id, doc, page, opened_at) VALUES (?,?,?,?)
             ON CONFLICT(user_id, doc) DO UPDATE SET
               page = excluded.page, opened_at = max(opened_at, excluded.opened_at)`,
      [user, doc, page, Date.now()],
    );
  }

  /** The per-doc web-open map the daemon folds into xochitl .metadata each
   *  tick (max-register merge on its side). */
  webOpens(user: string): { doc: string; page: string; at: number }[] {
    return this.db
      .query<{ doc: string; page: string; at: number }, [string]>(
        "SELECT doc, page, opened_at AS at FROM web_opens WHERE user_id=?",
      )
      .all(user);
  }

  /** Saved paths include the writer's absolute directory, which can change
   * on restore. Retain only the generated digest within the current tree. */
  private storedBlobPath(stored: string, folder: "" | "snapshots" = ""): string | null {
    const name = win32.basename(stored);
    if (name.length !== 64 || /[^0-9a-f]/.test(name)) return null;
    return join(this.filesDir, folder, name);
  }

  getPage(userId: string, doc: string, page: string): CloudPage | null {
    const row = this.db
      .query(
        "SELECT bytes, revision FROM pages WHERE user_id=? AND doc=? AND page=?",
      )
      .get(userId, doc, page) as { bytes: Uint8Array; revision: string } | null;
    return row
      ? { bytes: new Uint8Array(row.bytes), revision: row.revision }
      : null;
  }

  /** CAS write; returns new revision or {conflict} with the current one. */
  putPage(
    userId: string,
    doc: string,
    page: string,
    baseRevision: string,
    bytes: Uint8Array,
    originClient: string,
  ): { revision: string } | { conflict: string } {
    return this.publishPage(userId, doc, page, () => {
      const current = this.getPage(userId, doc, page);
      const currentRev = current?.revision ?? "";
      if (currentRev !== baseRevision) return { conflict: currentRev };
      const revision = sha256hex(bytes);
      this.db.run(
        `INSERT INTO pages (user_id, doc, page, bytes, revision, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id, doc, page) DO UPDATE SET bytes=excluded.bytes,
                  revision=excluded.revision, updated_at=excluded.updated_at`,
        [userId, doc, page, bytes, revision, Date.now()],
      );
      this.db.run(
        "INSERT INTO changes (user_id, doc, page, revision, origin_client, created_at) VALUES (?,?,?,?,?,?)",
        [userId, doc, page, revision, originClient, Date.now()],
      );
      // Keep the migration seed FRESH: if an op-mode reader already seeded this
      // still-zero-op page (snapshot exists, no ops), a blob write (tablet edit
      // via the daemon, or a kill-switch web client) must be re-seeded — else op
      // clients would keep bootstrapping the stale seed, and their first stroke
      // would flip the page op-mode WITHOUT this blob update (device ink loss).
      // Once the page has ops, the blob path is no longer authoritative and the
      // seed is never touched again. SNAPSHOT_KEEP prunes old seeds.
      if (
        this.latestOpSeq(userId, doc, page) === 0 &&
        this.latestSnapshot(userId, doc, page) !== null
      ) {
        this.seedBase(userId, doc, page, bytes);
      }
      return { revision };
    });
  }

  getOverlay(userId: string, doc: string, page: string): string | null {
    const row = this.db
      .query("SELECT json FROM overlays WHERE user_id=? AND doc=? AND page=?")
      .get(userId, doc, page) as { json: string } | null;
    return row?.json ?? null;
  }

  // ----- device bridge (#45 step 5b): op log <-> .rm for the codec-dumb daemon
  // The cloud runs the merge engine server-side for the device peer only
  // (SYNC-ARCHITECTURE §8/§12). A page is "op-mode" once it has any op; until
  // then the daemon keeps using the legacy blob path unchanged.

  /** True when a page is served from the op log rather than the legacy blob.
   *  A SNAPSHOT alone qualifies: a text-only web edit publishes a snapshot
   *  with zero ink ops, and judging op-mode by ops>0 made /rm fall back to
   *  a blob that does not exist (404 to the daemon AND the web). */
  isOpModePage(user: string, doc: string, page: string): boolean {
    return !!this.db.query(
      `SELECT 1 FROM page_ops WHERE user_id=?1 AND doc=?2 AND page=?3
       UNION ALL SELECT 1 FROM page_snapshots WHERE user_id=?1 AND doc=?2 AND page=?3
       LIMIT 1`,
    ).get(user, doc, page);
  }

  /** Highest snapshot seq for a page (0 if none) — a LIGHT query (no file
   *  read). Monotonic: seq is a global AUTOINCREMENT and pruning always keeps
   *  the newest row, so MAX(seq) only ever grows for a page. */
  latestSnapshotSeq(user: string, doc: string, page: string): number {
    const row = this.db
      .query<
        { s: number | null },
        [string, string, string]
      >("SELECT MAX(seq) AS s FROM page_snapshots WHERE user_id=? AND doc=? AND page=?")
      .get(user, doc, page);
    return row?.s ?? 0;
  }

  /** The device-facing revision marker for an op-mode page: op head AND
   *  snapshot head. The old `ops:N` marker ignored snapshots, so a
   *  snapshot-only edit (every device-TEXT edit publishes a snapshot with
   *  ZERO ops) produced change rows whose revision equaled the daemon's
   *  remembered one — pull_changes deduped them away and web text edits
   *  never reached the tablet again after the first pull (weft-cal15,
   *  live-confirmed: changes 668/669 consumed, tablet file untouched).
   *  Including the snapshot seq makes ANY server-side content change
   *  produce a fresh marker. Keeps the `ops:` prefix — the daemon's
   *  is_op_mode() and blob/op regime split key off it. */
  deviceRevision(user: string, doc: string, page: string): string {
    return opMarker(
      this.latestOpSeq(user, doc, page),
      this.latestSnapshotSeq(user, doc, page),
    );
  }

  /** Publish a validated restore to an empty account under one writer lock.
   * New checkpoint files are retired on rollback by the normal publisher. */
  restoreRecoveryNotebook(
    user: string, data: RecoveryImport, digest: string,
    storageCheck: (stage: "before" | "after") => void,
  ): "created" | "replay" | "not-empty" | "unverified" {
    const { notebook, pages } = data;
    const restore = () => this.publishPage(user, notebook.id, pages[0]!.id, () => {
      const receipt = this.db.query<{ digest: string }, [string]>(
        "SELECT digest FROM recovery_imports WHERE user_id=?",
      ).get(user);
      const list = JSON.parse(this.getDocuments(user)) as { documents?: { id?: unknown; deleted?: unknown; pages?: { id?: unknown }[] }[] };
      if (!Array.isArray(list.documents)) return "not-empty";
      const current = list.documents.find(d => d.id === notebook.id && d.deleted !== true);
      if (receipt?.digest === digest && current) {
        if (!Array.isArray(current.pages) ||
            !current.pages.every(p => p && typeof p.id === "string")) return "unverified";
        const retained = new Set(current.pages.map(p => p.id));
        return pages.every(p => !retained.has(p.id) || this.verifyRecoveredPage(user, notebook.id, p.id))
          ? "replay" : "unverified";
      }
      const hasRows = USAGE_TABLES.some(([table]) =>
        !!this.db.query(`SELECT 1 FROM ${table} WHERE user_id=? LIMIT 1`).get(user));
      if (receipt || list.documents.length || hasRows ||
          this.db.query("SELECT 1 FROM device_tokens WHERE user_id=? LIMIT 1").get(user)) {
        return "not-empty";
      }
      storageCheck("before");
      // Mark the account before generating checkpoint files so every snapshot
      // written by this restore (and future edits) records an integrity hash.
      this.db.run("INSERT INTO recovery_imports (user_id, digest) VALUES (?,?)", [user, digest]);
      const timestamp = Date.now();
      this.putDocuments(user, JSON.stringify({
        documents: [{ ...notebook, type: "notebook", parent: "", createdTime: timestamp, lastModified: timestamp }],
      }));
      for (const page of pages) {
        for (const { name, bytes } of page.assets) {
          this.putAsset(user, notebook.id, page.id, name, bytes);
        }
        this.putSnapshot(user, notebook.id, page.id, encodeSnapshot(page.native, page.overlay), false, 0);
        if (page.currentNative) {
          const base = this.deviceRevision(user, notebook.id, page.id);
          const { changed } = this.applyDevicePut(user, notebook.id, page.id, page.currentNative, base, "recovery");
          if (changed) continue; // the existing merge already recorded the head
        }
        this.recordOpChange(user, notebook.id, page.id, "recovery");
      }
      storageCheck("after");
      for (const path of this.stagedPageFiles!) this.syncPath(path);
      const snapshotsDir = join(this.filesDir, "snapshots");
      // A fresh relay may have just created snapshots/ and its parent.
      this.syncPath(snapshotsDir);
      this.syncPath(this.filesDir);
      this.syncPath(dirname(this.filesDir));
      return "created";
    });
    return withFullDurability(this.db, restore);
  }

  private syncPath(path: string): void {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); }
    finally { closeSync(fd); }
  }

  private verifyRecoveredPage(user: string, doc: string, page: string): boolean {
    try {
      const snapshot = this.latestSnapshotRow(user, doc, page);
      if (!snapshot?.sha256 || snapshot.op_seq < this.truncationFloor(user, doc, page)) return false;
      const path = this.existingSnapshotPath(snapshot.path);
      if (!path) return false;
      const bytes = readFileSync(path);
      if (sha256hex(bytes) !== snapshot.sha256) return false;
      const base = decodeSnapshot(bytes);
      const ops = this.opsInRange(user, doc, page, snapshot.op_seq, this.latestOpSeq(user, doc, page));
      const current = reconstructRm(base.rm, ops, DEVICE_BRIDGE_AUTHOR);
      for (const [, item] of RmDocument.parse(current).tree().walk()) {
        if (item.kind !== "image") continue;
        if (!item.filename) return false;
        const stored = this.db.query<{ bytes: Uint8Array; etag: string | null }, [string, string, string, string]>(
          "SELECT bytes, etag FROM assets WHERE user_id=? AND doc=? AND page=? AND file=?",
        ).get(user, doc, page, item.filename);
        if (!stored?.etag || sha256hex(stored.bytes) !== stored.etag) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Run a synchronous page write under SQLite's write lock. New snapshot
   * files are removed on rollback, and old files are pruned only after commit. */
  publishPage<T>(user: string, doc: string, page: string, write: () => T): T {
    const outer = this.stagedPageFiles;
    const files = outer ?? [];
    const outerRetired = this.retiredPageFiles;
    const retired = outerRetired ?? [];
    const start = files.length;
    const retiredStart = retired.length;
    this.stagedPageFiles = files;
    this.retiredPageFiles = retired;
    let result: T;
    try {
      result = this.db.transaction(write).immediate();
    } catch (error) {
      for (const path of files.splice(start)) this.removeSnapshotFile(path);
      retired.splice(retiredStart);
      throw error;
    } finally {
      this.stagedPageFiles = outer;
      this.retiredPageFiles = outerRetired;
    }
    if (!outer) for (const path of retired) this.removeSnapshotFile(path);
    if (!outer && files.length) {
      try {
        this.pruneSupersededSnapshots(user, doc, page);
      } catch (error) {
        console.error("weft-cloud: checkpoint pruning deferred", error);
      }
    }
    return result;
  }

  private removeSnapshotFile(storedPath: string): void {
    try {
      const path = this.storedBlobPath(storedPath, "snapshots");
      if (path) rmSync(path, { force: true });
    } catch (error) {
      console.error("weft-cloud: could not remove an unreferenced checkpoint", error);
    }
  }

  /** Record a change row (the daemon's /changes pull cursor) for an op-mode
   *  page so the device picks up op edits. revision is the op+snapshot head
   *  marker (deviceRevision); originClient lets the daemon skip its own
   *  pushes. */
  recordOpChange(
    user: string,
    doc: string,
    page: string,
    originClient: string,
  ): void {
    this.db.run(
      "INSERT INTO changes (user_id, doc, page, revision, origin_client, created_at) VALUES (?,?,?,?,?,?)",
      [
        user,
        doc,
        page,
        this.deviceRevision(user, doc, page),
        originClient,
        Date.now(),
      ],
    );
  }

  /** Materialize the current .rm for the daemon's GET /rm from the latest
   *  snapshot + the ops after it. Revision is an op-head marker (ops commute,
   *  so the daemon's CAS base is advisory, not enforced — see applyDevicePut). */
  reconstructDevicePage(user: string, doc: string, page: string, requireAvailable = false): CloudPage {
    let missingCheckpoint = 0;
    const replaced = (seq: number): boolean => {
      const firstRetained = this.db.query<{ seq: number }, [string, string, string, number]>(
        `SELECT seq FROM page_snapshots
          WHERE user_id=? AND doc=? AND page=? AND seq>=? ORDER BY seq LIMIT 1`,
      ).get(user, doc, page, seq);
      return !!firstRetained && firstRetained.seq > seq;
    };
    const read = this.db.transaction((retry?: { seq: number; error: unknown }) => {
      const snap = this.latestSnapshotRow(user, doc, page);
      if (retry && !replaced(retry.seq)) throw retry.error;
      const head = this.latestOpSeq(user, doc, page);
      let checkpoint: Uint8Array | null = null;
      if (snap && requireAvailable) {
        checkpoint = this.readRequiredCheckpoint(snap);
      } else if (snap) {
        const path = this.storedBlobPath(snap.path, "snapshots");
        if (!path) throw new Error("Invalid tablet checkpoint path");
        try {
          checkpoint = new Uint8Array(readFileSync(path));
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            missingCheckpoint = snap.seq;
          }
          throw error;
        }
      }
      const ops = this.opsInRange(user, doc, page, snap?.op_seq ?? 0, head);
      return { checkpoint, ops, revision: opMarker(head, snap?.seq ?? 0) };
    });

    let result: ReturnType<typeof read>;
    try {
      result = read();
    } catch (error) {
      // A missing file is recoverable only when retention removed its row
      // and a newer checkpoint still describes this page.
      if (!missingCheckpoint || this.db.inTransaction || !replaced(missingCheckpoint)) throw error;
      // SQLite snapshots preserve rows but cannot pin external files. Hold
      // the writer lock for the exceptional retry so its file stays readable.
      result = read.immediate({ seq: missingCheckpoint, error });
    }
    const snapRm = result.checkpoint ? decodeSnapshot(result.checkpoint).rm : null;
    const bytes = reconstructRm(snapRm, result.ops, DEVICE_BRIDGE_AUTHOR);
    return { bytes, revision: result.revision };
  }

  /**
   * The reconstruction AT a past device-revision marker ("ops:N+S"): snapshot
   * S's rm + the ops in (S.op_seq, N]. This is the CAUSAL BASE of a daemon
   * push (its x-base-revision — the exact state the daemon last wrote to /
   * read from the tablet file), which lets deletion detection be exact
   * ("live at base + absent from the push = deleted on device") instead of
   * clock-vector inference. Returns null whenever the base cannot be
   * FAITHFULLY rebuilt: the marker is invalid, the snapshot is gone, or the
   * op range was truncated. Callers then skip absence-based deletions.
   */
  private reconstructAtMarker(
    user: string,
    doc: string,
    page: string,
    marker: string,
  ): Uint8Array | null {
    const m = /^ops:(\d+)\+(\d+)$/.exec(marker);
    if (!m) {
      // a blob-era base: usable only if the blob row still holds EXACTLY the
      // revision the daemon is based on (sha-addressed, so it can't be stale)
      if (/^[0-9a-f]{64}$/.test(marker)) {
        const blob = this.getPage(user, doc, page);
        if (blob && blob.revision === marker) return blob.bytes;
      }
      return null;
    }
    const opHead = Number(m[1]);
    const snapSeq = Number(m[2]);
    if (!Number.isSafeInteger(opHead) || !Number.isSafeInteger(snapSeq)) return null;
    let snapOpSeq = 0;
    if (snapSeq > 0) {
      const row = this.db
        .query<{ op_seq: number }, [string, string, string, number]>(
          "SELECT op_seq FROM page_snapshots WHERE user_id=? AND doc=? AND page=? AND seq=?",
        )
        .get(user, doc, page, snapSeq);
      if (!row) return null;
      snapOpSeq = row.op_seq;
    }
    // the replay range (snapOpSeq, opHead] must be fully retained
    if (opHead < snapOpSeq || this.truncationFloor(user, doc, page) > snapOpSeq) return null;
    // Operation sequences are global, so a head inside the range may belong to another page.
    if (opHead > snapOpSeq) {
      const row = this.db.query<{ seq: number }, [string, string, string, number]>(
        "SELECT seq FROM page_ops WHERE user_id=? AND doc=? AND page=? AND seq=?",
      ).get(user, doc, page, opHead);
      if (!row) return null;
    }
    let snapRm: Uint8Array | null = null;
    if (snapSeq > 0) {
      const bytes = this.getSnapshotBytes(user, doc, page, snapSeq);
      if (!bytes) return null; // pruned: cannot rebuild this base
      snapRm = decodeSnapshot(bytes).rm;
    }
    const ops = this.opsInRange(user, doc, page, snapOpSeq, opHead);
    return reconstructRm(snapRm, ops, DEVICE_BRIDGE_AUTHOR);
  }

  /**
   * Apply the daemon's PUT /rm (xochitl's merged file) to an op-mode page:
   * diff it against the reconstructed current state and append the deltas it
   * introduced. No CAS — ops commute, so a stale base never rejects. When the
   * tablet introduced something the line diff can't represent (glyph/image),
   * publish a full snapshot (rm + current overlay) so peers re-bootstrap rather
   * than silently lose it. Returns the new op-head revision marker.
   *
   * `baseRevision` (the daemon's x-base-revision) scopes deletion detection
   * to the causal base when it can be reconstructed — see reconstructAtMarker
   * and deviceRemovedTombstones for the exact-vs-heuristic split.
   */
  applyDevicePut(
    user: string,
    doc: string,
    page: string,
    bytes: Uint8Array,
    baseRevision = "",
    originClient = "rmsyncd",
    checkStorage?: (before: number, after: number) => void,
  ): { revision: string; changed: boolean; merged: boolean } {
    return this.publishPage(user, doc, page, () => {
      const before = checkStorage ? this.usageBytes(user, "created") : 0;
      const stagedCount = this.stagedPageFiles!.length;
      const result = this.mergeDevicePage(user, doc, page, bytes, baseRevision, originClient);
      if (checkStorage && this.stagedPageFiles!.length > stagedCount) {
        this.pruneSupersededSnapshots(user, doc, page);
      }
      checkStorage?.(before, this.usageBytes(user, "created"));
      return result;
    });
  }

  private mergeDevicePage(
    user: string, doc: string, page: string, bytes: Uint8Array,
    baseRevision: string, originClient: string,
  ): { revision: string; changed: boolean; merged: boolean } {
    const { bytes: prev, revision } = this.reconstructDevicePage(user, doc, page);
    if (Buffer.compare(prev, bytes) === 0) {
      return { revision, changed: false, merged: false };
    }
    const causalBase = baseRevision === revision ||
        (/^[0-9a-f]{64}$/.test(baseRevision) && sha256hex(prev) === baseRevision)
      ? prev
      : baseRevision ? this.reconstructAtMarker(user, doc, page, baseRevision) : null;
    const currentNativeBase = causalBase !== null && Buffer.compare(prev, causalBase) === 0;
    // Backup-restore CLONES can share an author uuid + Lamport counter, so
    // two different concurrently-drawn strokes alias one (author, clock)
    // id and the diff silently drops one (attack panel). Re-key the
    // device's colliding items to fresh clocks BEFORE diffing; a re-key
    // forces merged=true below so the device pulls the union and adopts
    // the fresh ids (otherwise it would re-collide on every push).
    const rekey = currentNativeBase ? { bytes, rekeyed: 0 } : rekeyCloneCollisions(prev, bytes);
    if (rekey.rekeyed > 0) {
      bytes = rekey.bytes;
      console.error(
        `weft-cloud: re-keyed ${rekey.rekeyed} clone-colliding item(s) on ${doc}/${page}`,
      );
    }
    // Explicit tombstones in the device file (eraser deletions keep the
    // block with deletedLength>0) are gated by the causal base: one the
    // device merely carried through from its own pull must not re-kill an
    // item a later web restore resurrected.
    const { ops: rawOps, complete } = diffToOps(prev, bytes);
    const ops = gateTombstonesByBase(rawOps, causalBase);
    // diffToOps can't represent a device UNDO (xochitl removes the block
    // outright, not as a tombstone), so a stroke deleted on the tablet lived
    // on in the cloud forever and the two NEVER converged (weft-cal23 ghost
    // 4:529). Emit explicit tombstones for cloud-live strokes the tablet has
    // seen-and-removed so the deletion propagates as a real op.
    //
    // An EMPTY baseRevision makes no causal claim at all (fresh pairing, a
    // reset cloud-state.json, a re-pair): absence then means "never had it",
    // never "deleted it" — running the vector heuristic here false-deleted
    // web ink LIBRARY-WIDE after one state reset (attack panel H2). No base,
    // no absence-deletions; explicit eraser tombstones still flow above.
    //
    // A present-but-UNRECONSTRUCTABLE base (its replay range truncated by
    // retention) gets the same refusal, not the version-vector guess: the
    // vector heuristic could tombstone a stroke a web revert restored or a
    // late op re-introduced (attack panel H3/H4 — the last false-deletion
    // window). Deletions must come from EXACT provenance or not at all;
    // the cost is only that a beyond-retention device's absence-deletions
    // don't auto-propagate (its explicit eraser tombstones still do).
    // Moot today (RETENTION_KEEP_ALL); load-bearing the day truncation is
    // enabled. If that day comes, add device-base PINNING (clamp the floor
    // to the oldest base a live device token still holds) so real undo
    // propagation survives.
    const removals = causalBase
      ? deviceRemovedTombstones(prev, bytes, causalBase)
      : [];
    const allOps = removals.length > 0 ? [...ops, ...removals] : ops;
    if (allOps.length > 0) {
      this.appendOps(user, doc, page, allOps.map(encodeOp), DEVICE_BRIDGE_AUTHOR);
    }
    // RUNTIME BYTE-EQUALITY GUARD: `complete` promises the ops alone
    // reproduce this push byte-exactly — every violation of that promise so
    // far (2dp rounding 2026-07-14, valueless dead blocks 2026-07-16) became
    // the daemon rewriting the page under the user's pen, because the ops
    // were the ONLY record of the push. Enforce the promise instead of
    // assuming it: verify the reconstruction, and on any unknown diff
    // vocabulary gap demote to the snapshot path (cloud stays
    // device-faithful; no ops-only divergence can survive a push) and say so
    // loudly. Divergence is EXPECTED when the causal-base gate dropped a
    // tombstone (a web restore must win) or removals were inferred — the
    // merged pullback reconciles the device there, so those skip the check.
    const replay = allOps.length > 0 ? this.reconstructDevicePage(user, doc, page).bytes : prev;
    let faithful = complete;
    if (currentNativeBase) {
      faithful = Buffer.compare(replay, bytes) === 0;
    } else if (complete && ops.length === rawOps.length && removals.length === 0) {
      if (Buffer.compare(replay, bytes) !== 0) {
        // a mismatch that is PURELY cloud-extra content (web edits the tablet
        // hasn't pulled) is intended — the merged pullback delivers it. Any
        // device item missing or altered, or a mismatch with nothing extra to
        // explain it, is a vocabulary gap.
        const reproduced = deviceLinesReproduced(bytes, replay);
        if (!reproduced || !contentBeyond(bytes, replay)) {
          console.error(
            `weft-cloud: byte-equality violation on ${doc}/${page}: ops-path reconstruction diverges from the device push (items reproduced: ${reproduced}); storing snapshot fallback`,
          );
          faithful = false;
        }
      }
    }
    let after = replay;
    if (!faithful) {
      const merged = mergeForSnapshot(bytes, prev, causalBase ? { baseRm: causalBase } : "never");
      // Keep the original wire representation when the acknowledged page
      // matches the relay and the snapshot merge leaves its meaning intact.
      after = currentNativeBase && Buffer.compare(RmDocument.parse(bytes).serialize(), merged) === 0
        ? bytes : merged;
    }
    const checkpointChanged = !faithful && Buffer.compare(replay, after) !== 0;
    if (checkpointChanged) {
      const head = this.latestOpSeq(user, doc, page);
      // Fold the current overlay through the same head pinned by the snapshot.
      const { overlay } = this.stateAt(user, doc, page, head);
      this.putSnapshot(user, doc, page, encodeSnapshot(after, overlay), false, head);
    }
    // an idempotent carry-through (xochitl re-saving the same content) yields
    // no ops and no snapshot — report unchanged so the caller emits nothing.
    // The returned marker includes the snapshot head so the daemon's
    // remembered revision stays consistent with future change rows.
    const changed = allOps.length > 0 || checkpointChanged;
    // Publish one change row for the final head, including any fallback snapshot.
    if (changed) this.recordOpChange(user, doc, page, originClient);
    // `merged`: does the server's post-put state contain content the incoming
    // bytes LACK? True when the union-merge folded in concurrent web edits
    // (text the tablet hasn't seen), when the reconstruction holds web items
    // the tablet never pulled (a change row it missed), or when a web restore
    // resurrected an item the device still carries as dead. The daemon then
    // pulls right back, closing the divergence window instead of waiting for
    // the next foreign edit that may never come. Compared SEMANTICALLY
    // (contentBeyond: items + structure fingerprint + dead-vs-live), never by
    // byte equality — the merge re-serializes, so bytes always differ and a
    // byte compare would make every push trigger a spurious pull + tablet
    // file rewrite + reload.
    return {
      revision: this.deviceRevision(user, doc, page),
      changed,
      merged: rekey.rekeyed > 0 || contentBeyond(bytes, after),
    };
  }

  /** Prune change rows older than `retentionMs` (#63: the table was
   *  append-only and grew without bound). SAFE because of the revision
   *  sweep: a daemon whose cursor predates the retained window misses those
   *  rows, but its next sweep compares absolute markers and re-pulls
   *  whatever the pruned changes carried. MAX(seq) — the sweep's ETag
   *  validator — is unaffected (only old rows go, never the newest). */
  pruneChanges(retentionMs: number): number {
    return this.db.run("DELETE FROM changes WHERE created_at < ?", [
      Date.now() - retentionMs,
    ]).changes;
  }

  /** The user's newest change seq (0 if none) — the cheap VALIDATOR for the
   *  revision sweep. Every page-content mutation writes a change row, so an
   *  unchanged max seq proves the whole pageRevisions map is unchanged and
   *  the sweep can 304 with zero body instead of shipping every marker to a
   *  battery-powered tablet each reconcile. (seedSnapshotFromBlob writes no
   *  row, but the seed is byte-identical to the blob it mirrors — skipping
   *  that pull loses nothing.) */
  latestChangeSeq(userId: string): number {
    const row = this.db
      .query<{ s: number | null }, [string]>(
        "SELECT MAX(seq) AS s FROM changes WHERE user_id=?",
      )
      .get(userId);
    return row?.s ?? 0;
  }

  /** Every page this user has server-side, with its current device-facing
   *  revision (op-mode marker, or the blob sha for legacy pages). Backs the
   *  daemon's reconcile sweep (GET /api/revisions): a page whose cloud
   *  revision differs from the daemon's remembered one is re-pulled, so a
   *  change row that was ever missed or skipped self-heals instead of
   *  diverging forever. */
  pageRevisions(user: string): Record<string, string> {
    // One statement keeps page discovery and every head in the same SQLite
    // read snapshot, without a separate round trip for each page and cursor.
    const rows = this.db.query<{
      doc: string; page: string; op: number | null;
      snapshot: number | null; blob: string | null;
    }, [string]>(`
      WITH keys AS (
        SELECT doc, page FROM pages WHERE user_id=?1
        UNION SELECT DISTINCT doc, page FROM page_ops WHERE user_id=?1
        UNION SELECT DISTINCT doc, page FROM page_snapshots WHERE user_id=?1
      )
      SELECT k.doc, k.page,
        (SELECT MAX(seq) FROM page_ops
         WHERE user_id=?1 AND doc=k.doc AND page=k.page) AS op,
        (SELECT MAX(seq) FROM page_snapshots
         WHERE user_id=?1 AND doc=k.doc AND page=k.page) AS snapshot,
        (SELECT revision FROM pages
         WHERE user_id=?1 AND doc=k.doc AND page=k.page) AS blob
      FROM keys k
    `).all(user);
    return Object.fromEntries(rows.map(({ doc, page, op, snapshot, blob }) => [
      `${doc}/${page}`,
      op || snapshot ? opMarker(op ?? 0, snapshot ?? 0) : blob ?? "",
    ]));
  }

  /** An append receipt survives history truncation and suppresses a retry's
   * effects before even checking storage quota. */
  /** A receipt may outlive the HTTP connection. Before SQLite certifies it,
   * sync any new checkpoint files plus the current dependency and its
   * directory entries. Do not change the normal publication path. */
  private publishGuardedPage<T extends { kind: string }>(
    user: string, doc: string, page: string, write: () => T,
  ): T {
    if (this.db.inTransaction) throw new Error("Guarded receipt requires an outer durable transaction");
    return withFullDurability(this.db, () => this.publishPage(user, doc, page, () => {
      const result = write();
      if (result.kind !== "accepted") return result;
      const staged = new Set(this.stagedPageFiles);
      const head = this.latestSnapshotRow(user, doc, page);
      if (head) {
        const path = this.existingSnapshotPath(head.path);
        if (!path || statSync(path).size !== head.size) throw new SnapshotUnavailable();
        staged.add(path);
      }
      if (staged.size) {
        for (const path of staged) this.syncPath(path);
        this.syncPath(join(this.filesDir, "snapshots"));
        this.syncPath(this.filesDir);
        this.syncPath(dirname(this.filesDir));
      }
      return result;
    }));
  }

  publishOpsOnce(
    user: string,
    doc: string,
    page: string,
    batchId: string,
    bytes: Uint8Array,
    append: () => { firstSeq: number; lastSeq: number },
    baseSeq?: number,
  ):
    | { kind: "accepted"; range: { firstSeq: number; lastSeq: number }; duplicate: boolean }
    | { kind: "reused" }
    | { kind: "stale"; currentSeq: number } {
    const hash = (baseSeq === undefined ? "" : `base:${baseSeq}:`) + sha256hex(bytes);
    return this.publishGuardedPage(user, doc, page, () => {
      const key: [string, string, string, string] = [user, doc, page, batchId];
      const prior = this.db.query<
        { request_hash: string; first_seq: number; last_seq: number },
        typeof key
      >(
        `SELECT request_hash, first_seq, last_seq FROM page_op_batch_receipts
         WHERE user_id=? AND doc=? AND page=? AND batch_id=?`,
      ).get(...key);
      if (prior) {
        if (prior.request_hash !== hash) return { kind: "reused" };
        this.latestSnapshotReference(user, doc, page, true);
        return { kind: "accepted", range: { firstSeq: prior.first_seq, lastSeq: prior.last_seq }, duplicate: true };
      }
      if (baseSeq !== undefined) {
        const currentSeq = this.latestSnapshotReference(user, doc, page, true)?.seq ?? 0;
        if (currentSeq !== baseSeq) return { kind: "stale", currentSeq };
      }
      const range = append();
      this.db.run(
        `INSERT INTO page_op_batch_receipts
         (user_id, doc, page, batch_id, request_hash, first_seq, last_seq) VALUES (?,?,?,?,?,?,?)`,
        [...key, hash, range.firstSeq, range.lastSeq],
      );
      return { kind: "accepted", range, duplicate: false };
    });
  }

  /** Accept a client snapshot and its delivery marker in one publication.
   * Receipt matching precedes the base check: a retry of an accepted request
   * is an acknowledgement, even after another writer advanced the page. */
  publishSnapshot<T>(
    user: string,
    doc: string,
    page: string,
    bytes: Uint8Array,
    publication: SnapshotPublication | null,
    checkStorage: () => T | null,
    batch?: SnapshotBatch,
  ): SnapshotPublicationResult<T> {
    const requestHash = publication ? (batch ? "batch:" : "") + sha256hex(bytes) : null;
    const publish = publication ? this.publishGuardedPage.bind(this) : this.publishPage.bind(this);
    return publish(user, doc, page, () => {
      if (publication) {
        const receipt = this.db.query<
          { request_hash: string; base_seq: number; seq: number; merged: number },
          [string, string, string, string]
        >(`SELECT request_hash, base_seq, seq, merged FROM page_snapshot_receipts
           WHERE user_id=? AND doc=? AND page=? AND publication_id=?`)
          .get(user, doc, page, publication.id);
        if (receipt) {
          if (receipt.request_hash !== requestHash || receipt.base_seq !== publication.baseSeq) {
            return { kind: "reused" };
          }
          // The receipt’s own checkpoint may have been pruned; the current
          // head must still be readable to acknowledge the publication.
          this.latestSnapshotReference(user, doc, page, true);
          return { kind: "accepted", seq: receipt.seq, merged: receipt.merged === 1, duplicate: true };
        }
        const currentSeq = this.latestSnapshotReference(user, doc, page, true)?.seq ?? 0;
        if (publication.baseSeq !== currentSeq) return { kind: "stale", currentSeq };
      }

      const blocked = checkStorage();
      if (blocked !== null) return { kind: "blocked", response: blocked };

      if (batch) this.appendOps(user, doc, page, batch.deltas, batch.author);
      // Guarded publications may pin past both existing and newly appended
      // deltas. Do not acknowledge a checkpoint we could not safely merge.
      const { seq, merged } = this.putSnapshotMerged(
        user, doc, page, batch?.snapshot ?? bytes, { requireMerge: publication !== null },
      );
      if (publication) {
        this.db.run(
          `INSERT INTO page_snapshot_receipts
             (user_id, doc, page, publication_id, request_hash, base_seq, seq, merged)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [user, doc, page, publication.id, requestHash, publication.baseSeq, seq, merged ? 1 : 0],
        );
      }
      this.recordOpChange(user, doc, page, "web");
      return { kind: "accepted", seq, merged, duplicate: false };
    });
  }

  /**
   * Snapshot publication from a CLIENT (the web's PUT /snapshot): union-merge
   * the incoming container with the current reconstruction before storing,
   * so concurrent edits the publisher has not seen (tablet typing, another
   * client's ink) are folded in instead of clobbered. No base state = store
   * verbatim.
   */
  putSnapshotMerged(
    user: string,
    doc: string,
    page: string,
    container: Uint8Array,
    { requireMerge = false }: { requireMerge?: boolean } = {},
  ): { seq: number; merged: boolean } {
    const hasBase =
      this.latestSnapshotRow(user, doc, page) !== null ||
      this.latestOpSeq(user, doc, page) > 0;
    if (!hasBase) {
      if (requireMerge) {
        const snapshot = decodeSnapshot(container);
        RmDocument.parse(snapshot.rm);
        if (!Array.isArray(snapshot.overlay?.shapes)) throw new Error("Invalid snapshot overlay");
      }
      return { seq: this.putSnapshot(user, doc, page, container), merged: false };
    }
    let bytes: Uint8Array;
    let merged: boolean;
    try {
      // Validate the committed storage basis before attempting the optional
      // format merge: an opaque incoming container must not hide storage loss.
      const prev = this.reconstructDevicePage(user, doc, page, true).bytes;
      const snap = decodeSnapshot(container);
      if (requireMerge && (!prev || Buffer.compare(snap.rm, prev) === 0)) {
        // The merge fast path otherwise returns these bytes without parsing.
        RmDocument.parse(snap.rm);
      }
      // web publishers keep explicit tombstones for every deletion, so an
      // absent item can only mean "never seen" — always re-add ("never").
      const mergedRm = mergeForSnapshot(snap.rm, prev, "never");
      // The OVERLAY needs the same protection as the ink above. Taking the
      // publisher's overlay VERBATIM let a client that published a stale/empty
      // overlay (a transient document-replaced, an open before objects loaded)
      // WIPE every semantic shape it lacked — while mergeForSnapshot preserved
      // the ink — leaving orphaned raw ink with no text mapping and no reattach
      // option (WEFT-MEASURE-B / weft-cal15 copy 2: overlay went 2 shapes -> 0
      // on a snapshot pinned PAST the upsert-object ops, so reconstruction
      // trusted it and never replayed them = permanent loss). Union-merge the
      // publisher's overlay INTO the current reconstructed overlay: a shape the
      // publisher merely lacks (no tombstone) survives; a real deletion (a
      // newer tombstone) still wins — the same rule the client uses on adoption.
      const mergedOverlay = mergeOverlayDocuments(
        this.overlayAtHead(user, doc, page, true),
        snap.overlay,
      );
      bytes = encodeSnapshot(mergedRm, mergedOverlay);
      // `merged`: did `prev` contribute content the publisher's bytes LACK
      // (a concurrent tablet edit folded in)? The publisher must then pull
      // this snapshot back or its replica silently misses the tablet edit —
      // it recorded its own seq precisely so it never re-bootstraps from its
      // own snapshots (the web mirror of the weft-cal15 class). Diffed
      // SEMANTICALLY against the merge OUTPUT (which contains the incoming
      // content by construction), so a publisher that was fully caught up
      // reads merged=false and never churns.
      // The merge already validated these bytes. Identical drawings cannot
      // add visible content, so avoid decoding them again to prove that.
      const byId = (shapes: typeof snap.overlay.shapes) =>
        new Map(shapes.map((shape) => [shape.shapeId, shape]));
      merged =
        (Buffer.compare(snap.rm, mergedRm) !== 0 && contentBeyond(snap.rm, mergedRm)) ||
        !isDeepStrictEqual(byId(snap.overlay.shapes), byId(mergedOverlay.shapes)) ||
        !isDeepStrictEqual(snap.overlay.tombstones ?? {}, mergedOverlay.tombstones ?? {});
    } catch (error) {
      if (requireMerge || error instanceof RootTextAuthorConflict || error instanceof CheckpointUnavailableError) throw error;
      // the snapshot channel is contractually OPAQUE: anything we cannot
      // parse (tests, future formats) stores verbatim, exactly as before —
      // the merge is best-effort protection for real .rm containers
      bytes = container;
      merged = false;
    }
    return { seq: this.putSnapshot(user, doc, page, bytes), merged };
  }

  /**
   * Blob->snapshot migration (the "5d" step), done LAZILY: a page written under
   * the legacy blob-CAS regime has content in `pages`/`overlays` but no
   * snapshot, so an op-mode client bootstrapping from getSnapshot would see it
   * EMPTY — and its first stroke would flip the page op-mode with the blob
   * content missing from the log, after which the daemon's GET /rm reconstruct
   * would overwrite the tablet's .rm and LOSE the pre-existing ink. Seeding the
   * legacy blob (+ overlay sidecar) as the base snapshot before any op-mode
   * read/append makes the transition lossless. Called from the op-mode routes
   * (GET /snapshot, POST /ops, history/at/revert); a no-op once any snapshot
   * exists or when there is nothing to migrate.
   *
   * Seeding happens ONLY while the page has zero ops. Once ops exist without a
   * snapshot (a page that went op-mode through a pre-migration empty
   * bootstrap), the blob is deliberately NOT unioned in: ops minted against an
   * empty base reuse the same (authorUuid, clock) ids the blob's items already
   * occupy, so an ink "union" would silently drop the colliding strokes —
   * a fake recovery that loses data. The op content stands; the blob remains
   * readable in `pages` for manual recovery. (In the REAL client flow this
   * case cannot arise: bootstrap runs before any append, so the first op is
   * always minted against the seeded blob base with non-colliding clocks.)
   */
  seedSnapshotFromBlob(user: string, doc: string, page: string): boolean {
    if (this.latestSnapshotRow(user, doc, page)) return false; // never replace a known checkpoint with a legacy blob
    if (this.latestOpSeq(user, doc, page) > 0) return false; // op content stands
    const blob = this.getPage(user, doc, page);
    if (!blob) return false; // nothing to migrate (fresh/op-born page)
    this.seedBase(user, doc, page, blob.bytes);
    return true;
  }

  /** The one seed primitive both migration paths share: pin `bytes` (+ the
   *  legacy overlay sidecar) as the base snapshot at op_seq 0. Guards live
   *  in the two callers — putPage refreshes a still-zero-op seed after a
   *  blob write; seedSnapshotFromBlob migrates lazily before op-mode reads. */
  private seedBase(user: string, doc: string, page: string, bytes: Uint8Array): void {
    const overlayJson = this.getOverlay(user, doc, page);
    const overlay: OverlayDocument = overlayJson
      ? JSON.parse(overlayJson)
      : { shapes: [] };
    this.putSnapshot(user, doc, page, encodeSnapshot(bytes, overlay), false, 0);
  }

  putAsset(
    user: string,
    doc: string,
    page: string,
    file: string,
    bytes: Uint8Array,
  ): void {
    this.db.run(
      "INSERT OR REPLACE INTO assets (user_id, doc, page, file, bytes, etag) VALUES (?, ?, ?, ?, ?, ?)",
      [user, doc, page, file, bytes, sha256hex(bytes)],
    );
  }

  /** Existing rows may lack a hash after upgrade. Their marker changes on
   * the first subsequent PUT, and remains stable until the bytes are replaced. */
  private recoveryAssetMarker(
    rows: { file: string; etag: string | null }[], legacyOverlay: string | null = null,
  ): string {
    if (!rows.length && legacyOverlay === null) return "";
    return sha256hex(Buffer.from(JSON.stringify([rows.map(({ file, etag }) => [file, etag]), legacyOverlay])));
  }

  /** A separate marker per page lets an asset-only overwrite wake the tablet
   * even if the native revision and the retained change feed did not change.
   * Legacy blob overlays can change independently of the native revision too. */
  recoveryAssetRevisions(user: string): Record<string, string> {
    const rows = this.db.query<
      { doc: string; page: string; file: string; etag: string | null }, [string]
    >("SELECT doc, page, file, etag FROM assets WHERE user_id=? ORDER BY doc, page, file").all(user);
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.doc}/${row.page}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
    const legacy = this.db.query<{ doc: string; page: string; json: string }, [string]>(`
      SELECT o.doc, o.page, o.json FROM overlays o
      WHERE o.user_id=?1
        AND NOT EXISTS (SELECT 1 FROM page_ops p WHERE p.user_id=?1 AND p.doc=o.doc AND p.page=o.page)
        AND NOT EXISTS (SELECT 1 FROM page_snapshots s WHERE s.user_id=?1 AND s.doc=o.doc AND s.page=o.page)
    `).all(user);
    const legacyByPage = new Map(legacy.map(({ doc, page, json }) => [`${doc}/${page}`, json]));
    const keys = new Set([...groups.keys(), ...legacyByPage.keys()]);
    return Object.fromEntries([...keys].map((key) => [
      key, this.recoveryAssetMarker(groups.get(key) ?? [], legacyByPage.get(key) ?? null),
    ]));
  }

  readRecoveryRevisions(user: string, ifNoneMatch: string | null) {
    return this.db.transaction(() => {
      const epoch = this.db.query<{ epoch: number }, [string]>(
        "SELECT epoch FROM recovery_epochs WHERE user_id=?",
      ).get(user)?.epoch ?? 0;
      const etag = `"recovery-v1-${this.latestChangeSeq(user)}-${epoch}"`;
      return ifNoneMatch === etag
        ? { etag, body: null }
        : { etag, body: { pages: this.pageRevisions(user), assets: this.recoveryAssetRevisions(user) } };
    })();
  }

  /** Read all members of the recovery revision in the same SQLite snapshot.
   * Missing checkpoint files fail closed instead of replaying against empty ink. */
  readRecoveryPage(
    user: string, doc: string, page: string,
    knownNative: string | null, ifNoneMatch: string | null,
  ) {
    return this.db.transaction(() => {
      const snapshot = this.latestSnapshotRow(user, doc, page);
      const snapshotSeq = snapshot?.seq ?? 0;
      const opSeq = this.latestOpSeq(user, doc, page);
      const blob = snapshotSeq || opSeq ? null : this.getPage(user, doc, page);
      if (!snapshotSeq && !opSeq && !blob) return null;
      const revision = blob?.revision ?? opMarker(opSeq, snapshotSeq);
      const legacyOverlay = blob ? this.getOverlay(user, doc, page) : null;
      const rows = this.db.query<{ file: string; etag: string | null }, [string,string,string]>(
        "SELECT file, etag FROM assets WHERE user_id=? AND doc=? AND page=? ORDER BY file",
      ).all(user, doc, page);
      const assetRevision = this.recoveryAssetMarker(rows, legacyOverlay);
      const etagFor = (native: string) =>
        `"${sha256hex(Buffer.from(JSON.stringify([revision, native, assetRevision, legacyOverlay])))}"`;
      // The client must still hold the exact native bytes for a 304. Including
      // their digest in the validator makes the common conditional check cheap.
      if (knownNative && /^[a-f0-9]{64}$/.test(knownNative) && ifNoneMatch === etagFor(knownNative)) {
        return { etag: ifNoneMatch, body: null };
      }

      if (this.truncationFloor(user, doc, page) > (snapshot?.op_seq ?? 0)) {
        throw new Error("Recovery checkpoint is below the retained operation floor");
      }
      const checkpointPath = snapshot ? this.storedBlobPath(snapshot.path, "snapshots") : null;
      if (snapshot && !checkpointPath) throw new Error("Invalid recovery checkpoint path");
      const checkpoint = checkpointPath
        ? decodeSnapshot(new Uint8Array(readFileSync(checkpointPath))) : null;
      const ops = this.opsInRange(user, doc, page, snapshot?.op_seq ?? 0, opSeq);
      const native = blob?.bytes ?? reconstructRm(checkpoint?.rm ?? null, ops, DEVICE_BRIDGE_AUTHOR);
      const overlay: OverlayDocument = checkpoint?.overlay ?? (legacyOverlay ? JSON.parse(legacyOverlay) : { shapes: [] });
      foldOverlayOps(overlay, ops);
      const nativeSha256 = sha256hex(native);
      const required = new Set<string>();
      const missingAssets = new Set<string>();
      for (const [, item] of RmDocument.parse(native).tree().walk()) {
        if (item.kind !== "image") continue;
        if (item.filename) required.add(item.filename);
        else missingAssets.add("<unresolved image>");
      }
      const assets = [];
      for (const { file, etag } of rows) {
        if (!required.delete(file)) continue;
        const bytes = etag ? null : this.getAsset(user, doc, page, file);
        if (!etag && !bytes) throw new Error("Recovery asset disappeared");
        assets.push({ name: file, sha256: etag ?? sha256hex(bytes!) });
      }
      for (const file of required) missingAssets.add(file);
      return {
        etag: etagFor(nativeSha256),
        body: {
          revision, snapshotSeq, opSeq, nativeSha256, assetRevision,
          nativeBase64: nativeSha256 === knownNative ? null : Buffer.from(native).toString("base64"),
          overlay, assets, missingAssets: [...missingAssets],
        },
      };
    })();
  }

  listAssets(user: string, doc: string, page: string): string[] {
    return this.db
      .query<{ file: string }, [string, string, string]>(
        "SELECT file FROM assets WHERE user_id = ? AND doc = ? AND page = ? ORDER BY file",
      )
      .all(user, doc, page)
      .map((r) => r.file);
  }

  getAsset(
    user: string,
    doc: string,
    page: string,
    file: string,
  ): Uint8Array | null {
    const row = this.db
      .query<
        { bytes: Uint8Array },
        [string, string, string, string]
      >("SELECT bytes FROM assets WHERE user_id = ? AND doc = ? AND page = ? AND file = ?")
      .get(user, doc, page, file);
    return row ? new Uint8Array(row.bytes) : null;
  }

  // Page thumbnails: xochitl's own rendered preview (PNG), pushed by the
  // daemon so the hosted library can show the same image the tablet shows.
  // The etag (sha256 of the bytes) backs the client's stale-while-revalidate
  // cache: If-None-Match answers 304 instead of re-sending every PNG.
  putThumbnail(
    user: string,
    doc: string,
    page: string,
    bytes: Uint8Array,
  ): void {
    this.db.run(
      "INSERT OR REPLACE INTO thumbnails (user_id, doc, page, bytes, etag) VALUES (?, ?, ?, ?, ?)",
      [user, doc, page, bytes, sha256hex(bytes)],
    );
  }

  getThumbnail(
    user: string,
    doc: string,
    page: string,
  ): { bytes: Uint8Array; etag: string } | null {
    const row = this.db
      .query<
        { bytes: Uint8Array; etag: string | null },
        [string, string, string]
      >("SELECT bytes, etag FROM thumbnails WHERE user_id = ? AND doc = ? AND page = ?")
      .get(user, doc, page);
    if (!row) return null;
    const bytes = new Uint8Array(row.bytes);
    let etag = row.etag;
    if (!etag) {
      // pre-etag row: backfill once on read
      etag = sha256hex(bytes);
      this.db.run(
        "UPDATE thumbnails SET etag=? WHERE user_id=? AND doc=? AND page=?",
        [etag, user, doc, page],
      );
    }
    return { bytes, etag };
  }

  // Document source file (PDF, or xochitl's EPUB->PDF conversion): the
  // underlay the editor renders behind the ink. One per document. The etag
  // (sha256 of the bytes — the file's REVISION; a re-imported PDF is a new
  // one) backs the browser's Cache API layer via If-None-Match.
  putFile(
    user: string,
    doc: string,
    bytes: Uint8Array,
    mime = "application/pdf",
    limit = 0,
  ): boolean {
    const etag = sha256hex(bytes);
    let staged: string | undefined;
    const retired: string[] = [];
    try {
      const published = this.commitSources(() => {
        const old = this.sourceRow(user, doc);
        const needed = this.usageBytes(user, "sources") - (old?.size ?? 0) + bytes.length - limit;
        const victims = limit > 0 && needed > 0 ? this.colderSources(user, doc, needed) : [];
        if (!victims) return false;

        // Do not truncate the live source (including a pre-upgrade file).
        // Put the replacement on durable storage before publishing its row.
        const path = join(this.filesDir, sha256hex(new TextEncoder().encode(crypto.randomUUID())));
        const fd = openSync(path, "wx", 0o600);
        staged = path;
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        this.syncPath(this.filesDir);
        this.syncPath(dirname(this.filesDir));
        this.db.run(
          "INSERT OR REPLACE INTO files (user_id, doc, path, size, mime, etag) VALUES (?, ?, ?, ?, ?, ?)",
          [user, doc, path, bytes.length, mime, etag],
        );
        if (old) retired.push(old.path);
        for (const victim of victims) {
          this.db.run("DELETE FROM files WHERE user_id=? AND doc=?", [user, victim.doc]);
          retired.push(victim.path);
        }
        return true;
      });
      // A stale reader may still hold the old inode; unlink is safe for it.
      for (const path of retired) this.unlinkSource(path);
      return published;
    } catch (error) {
      // Never remove a possibly committed blob if checking the DB also fails.
      // Startup reconciles either side of an interrupted publication.
      if (staged) {
        try {
          if (this.sourceRow(user, doc)?.path !== staged) this.unlinkSource(staged);
        } catch {}
      }
      throw error;
    }
  }

  private sourceRow(user: string, doc: string) {
    return this.db.query<{ path: string; size: number; mime: string; etag: string }, [string, string]>(
      "SELECT path, size, mime, etag FROM files WHERE user_id=? AND doc=?",
    ).get(user, doc);
  }

  private commitSources<T>(write: () => T): T {
    // No autocommit ROW can be lost to a WAL reset after deleting its old
    // files. BEGIN IMMEDIATE also serializes quota planning with other writers.
    return withFullDurability(this.db, () => this.db.transaction(write).immediate());
  }

  private unlinkSource(stored: string): void {
    const path = this.storedBlobPath(stored);
    if (!path) return;
    try { rmSync(path, { force: true }); }
    catch (error) { console.error("weft-cloud: source cleanup deferred:", (error as NodeJS.ErrnoException).code); }
  }

  private reclaimOrphanSources(): void {
    // Covers a crash before COMMIT (staged candidate) or after it (retired
    // blobs). The writer lock prevents sweeping another process's candidate.
    this.db.transaction(() => {
      const live = new Set(this.db.query<{ path: string }, []>("SELECT path FROM files").all()
        .map(({ path }) => this.storedBlobPath(path)));
      for (const entry of readdirSync(this.filesDir, { withFileTypes: true })) {
        if (entry.isFile() && /^[0-9a-f]{64}$/.test(entry.name) && !live.has(join(this.filesDir, entry.name))) {
          this.unlinkSource(entry.name);
        }
      }
    }).immediate();
  }

  /** Disk reference for a document's source file (for streaming + Range), or
   *  null if absent. A stale row whose file vanished is treated as absent. */
  getFileRef(
    user: string,
    doc: string,
  ): { path: string; size: number; mime: string; etag: string } | null {
    const row = this.sourceRow(user, doc);
    if (!row) return null;
    const path = this.storedBlobPath(row.path);
    if (!path) return null;
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat ? { path, size: stat.size, mime: row.mime, etag: row.etag } : null;
  }

  /** Full bytes of a document's source file (used by tests/back-compat). */
  getFile(user: string, doc: string): Uint8Array | null {
    const ref = this.getFileRef(user, doc);
    return ref ? new Uint8Array(readFileSync(ref.path)) : null;
  }

  /** Doc ids that currently have a RESIDENT source file (the daemon reads this
   *  to learn which sources the cloud evicted, so it can re-push a re-opened
   *  one — #81). */
  residentSources(user: string): string[] {
    return this.db
      .query<{ doc: string }, [string]>(
        "SELECT doc FROM files WHERE user_id=? ORDER BY doc",
      )
      .all(user)
      .map((r) => r.doc);
  }

  /** Delete a document's source file (row + bytes on disk). Returns the freed
   *  bytes. The source is NOT lost — it still lives on the tablet and re-pushes
   *  when it's hot enough to be resident again. */
  deleteFile(user: string, doc: string): number {
    const ref = this.commitSources(() => {
      const row = this.sourceRow(user, doc);
      if (row) this.db.run("DELETE FROM files WHERE user_id=? AND doc=?", [user, doc]);
      return row;
    });
    if (!ref) return 0;
    const path = this.storedBlobPath(ref.path);
    const size = path ? statSync(path, { throwIfNoEntry: false })?.size ?? 0 : 0;
    this.unlinkSource(ref.path);
    return size;
  }

  /** A doc's lastOpened (epoch ms) from the stored doc list, or 0 (never opened
   *  / unknown) — the recency key the source rotation ranks by. */
  docLastOpened(user: string, doc: string): number {
    try {
      const list = JSON.parse(this.getDocuments(user)) as {
        documents?: { id?: unknown; lastOpened?: unknown }[];
      };
      const d = (list.documents ?? []).find((x) => x.id === doc);
      const v = d?.lastOpened;
      const n = typeof v === "string" ? Number(v) : v;
      return typeof n === "number" && Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  /** Plan enough strictly colder removals, or return null without taking any. */
  private colderSources(user: string, incomingDoc: string, needed: number) {
    const incomingLastOpened = this.docLastOpened(user, incomingDoc);
    const colder = this.db.query<{ doc: string; path: string; size: number }, [string, string]>(
      "SELECT doc, path, size FROM files WHERE user_id=? AND doc!=? ORDER BY doc",
    ).all(user, incomingDoc)
      .map(row => ({ ...row, lastOpened: this.docLastOpened(user, row.doc) }))
      .filter(row => row.lastOpened < incomingLastOpened)
      .sort((a, b) => a.lastOpened - b.lastOpened);
    for (let i = 0; i < colder.length; i++) {
      needed -= colder[i]!.size;
      if (needed <= 0) return colder.slice(0, i + 1);
    }
    return null;
  }

  // Page templates (reMarkable's line/grid backgrounds), per user so one
  // user can never overwrite another's. The daemon pushes the ones its
  // notebooks reference.
  putTemplate(
    user: string,
    name: string,
    mime: string,
    bytes: Uint8Array,
  ): void {
    this.db.run(
      "INSERT OR REPLACE INTO templates (user_id, name, mime, bytes) VALUES (?, ?, ?, ?)",
      [user, name, mime, bytes],
    );
  }

  getTemplate(
    user: string,
    name: string,
  ): { mime: string; bytes: Uint8Array } | null {
    const row = this.db
      .query<
        { mime: string; bytes: Uint8Array },
        [string, string]
      >("SELECT mime, bytes FROM templates WHERE user_id = ? AND name = ?")
      .get(user, name);
    return row ? { mime: row.mime, bytes: new Uint8Array(row.bytes) } : null;
  }

  /**
   * The user's synced templates with display metadata for a picker (#60/C).
   * `name` is the KEY (the on-device filename stem a page's `template` field
   * references, e.g. "LS Grid bottom"); display name/categories/orientation
   * are read from inside each JSON-DSL template. Legacy image templates
   * (png/svg, rm2-era) carry no metadata — kind "image", name as label.
   */
  listTemplates(user: string): {
    name: string;
    kind: "json" | "image";
    displayName: string;
    orientation: string | null;
    categories: string[];
  }[] {
    const rows = this.db
      .query<
        { name: string; mime: string; bytes: Uint8Array },
        [string]
      >("SELECT name, mime, bytes FROM templates WHERE user_id = ? ORDER BY name")
      .all(user);
    return rows.map((r) => {
      if (r.mime.includes("json")) {
        try {
          const t = JSON.parse(new TextDecoder().decode(r.bytes)) as {
            name?: unknown;
            orientation?: unknown;
            categories?: unknown;
          };
          return {
            name: r.name,
            kind: "json" as const,
            displayName: typeof t.name === "string" ? t.name : r.name,
            orientation:
              typeof t.orientation === "string" ? t.orientation : null,
            categories: Array.isArray(t.categories)
              ? t.categories.filter((c): c is string => typeof c === "string")
              : [],
          };
        } catch {
          /* fall through to the image shape */
        }
      }
      return {
        name: r.name,
        kind: "image" as const,
        displayName: r.name,
        orientation: null,
        categories: [],
      };
    });
  }

  /**
   * Set one page's template in the stored doc list (#60/C: the web picker's
   * write path). Mutates the page entry's `template` and bumps the DOC's
   * lastModified to `now` so the daemon's per-doc LWW pull (D11) applies it
   * device-ward once the daemon learns page templates. Returns false when
   * the doc/page isn't in the list (nothing written).
   */
  setPageTemplate(
    user: string,
    doc: string,
    page: string,
    template: string,
  ): boolean {
    type PageEntry = { id?: unknown; template?: unknown };
    type Doc = {
      id?: unknown;
      lastModified?: unknown;
      pages?: PageEntry[];
    };
    let parsed: { documents?: Doc[] };
    try {
      parsed = JSON.parse(this.getDocuments(user)) as { documents?: Doc[] };
    } catch {
      return false;
    }
    const docs = Array.isArray(parsed.documents) ? parsed.documents : [];
    const d = docs.find((x) => x.id === doc);
    const p = d?.pages?.find((x) => x.id === page);
    if (!d || !p) return false;
    p.template = template;
    const now = Date.now();
    d.lastModified = now;
    // per-page template REGISTER stamp: outranks a device's carried-through
    // whole-doc claim, so the pick survives tablet content edits/clock skew
    const fs = ((d as { fieldStamps?: Record<string, unknown> }).fieldStamps ??= {});
    fs[`t:${page}`] = now;
    this.putDocuments(user, JSON.stringify({ documents: docs }));
    return true;
  }

  putOverlay(userId: string, doc: string, page: string, json: string): void {
    this.db.run(
      `INSERT INTO overlays (user_id, doc, page, json) VALUES (?,?,?,?)
             ON CONFLICT(user_id, doc, page) DO UPDATE SET json=excluded.json`,
      [userId, doc, page, json],
    );
  }

  getDocuments(userId: string): string {
    const row = this.db
      .query("SELECT json FROM documents WHERE user_id=?")
      .get(userId) as { json: string } | null;
    return row?.json ?? '{"documents":[]}';
  }

  putDocuments(userId: string, json: string): void {
    this.db.run(
      `INSERT INTO documents (user_id, json, updated_at) VALUES (?,?,?)
             ON CONFLICT(user_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`,
      [userId, json, Date.now()],
    );
  }

  /**
   * Per-doc LWW merge of an incoming doc list into the stored one (#50-lite,
   * D11) — replaces the old blind whole-list swap, which lost a web rename
   * whenever the daemon pushed its (stale) list in the same window.
   *
   * Rules:
   *  - Docs are merged BY ID; for a doc present on both sides the newer
   *    `lastModified` wins. A missing/unparseable lastModified counts as 0
   *    (pre-#50 lists and daemon docs without one — always-oldest, matching
   *    the daemon's own pull-side rule that such docs are excluded from LWW).
   *    Ties go to the INCOMING doc (degenerates to today's behavior for
   *    no-op re-pushes). lastModified may be a number or numeric string.
   *  - Absence: only an AUTHORITATIVE writer (the daemon — its list is the
   *    device's complete tree, `via === 'device'`) removes stored docs that
   *    are absent from its push; this is exactly how tablet deletions have
   *    always propagated. Non-authoritative writers (browser, API keys)
   *    merge only — a partial third-party PUT can never wipe the library.
   *  - Cycle/dangling guard: after merging, any doc whose parent chain
   *    revisits a node or references a folder id that does not exist is
   *    clamped to root ("") — nothing is ever lost, worst case it surfaces
   *    at the top level. ("trash" is a terminal parent, like root.)
   *
   * Returns the merged JSON that was stored.
   */
  mergeDocuments(
    userId: string,
    incomingJson: string,
    /** sha256 of the pushing DEVICE's token; null for web/API writers
     *  (merge-only, no deletion authority). */
    deviceKey: string | null,
  ): string {
    type Doc = { id?: unknown; parent?: unknown; lastModified?: unknown } & {
      [k: string]: unknown;
    };
    const parseDocs = (json: string): Doc[] => {
      try {
        const v = JSON.parse(json) as { documents?: unknown };
        return Array.isArray(v.documents) ? (v.documents as Doc[]) : [];
      } catch {
        return [];
      }
    };
    const lm = (d: Doc): number => {
      const v = d.lastModified;
      const n = typeof v === "string" ? Number(v) : v;
      return typeof n === "number" && Number.isFinite(n) ? n : 0;
    };
    // entries can be ANY JSON (null, numbers, id-less junk) — never trust them
    const isDoc = (d: unknown): d is Doc & { id: string } =>
      typeof d === "object" &&
      d !== null &&
      typeof (d as Doc).id === "string" &&
      ((d as Doc).id as string).length > 0;
    const incoming = parseDocs(incomingJson).filter(isDoc);
    const stored = parseDocs(this.getDocuments(userId));

    // #80: per-field LWW for name and parent, so a web MOVE can never clobber
    // a concurrent tablet RENAME (and vice versa). Each doc may carry
    // `fieldStamps: { name?, parent? }`:
    //  - a writer WITH fieldStamps claims ONLY the listed fields at those
    //    stamps (the web's moveDoc stamps just `parent`) — unlisted fields
    //    claim nothing, so carried-through values can't win;
    //  - a writer WITHOUT them (the daemon; legacy clients) claims both at
    //    its whole-doc lastModified, matching the device's single-stamp
    //    model. Everything else (pages, template, cover…) still follows the
    //    whole-doc lastModified winner, and the stored doc records the merged
    //    stamps for the next round.
    type Stamps = { name?: number; parent?: number };
    const stampsOf = (d: Doc): Stamps | null => {
      const fs = (d as { fieldStamps?: unknown }).fieldStamps;
      if (typeof fs !== "object" || fs === null) return null;
      const pick = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      const s = fs as { name?: unknown; parent?: unknown };
      const stamps: Stamps = {};
      for (const field of ["name", "parent"] as const) {
        const stamp = pick(s[field]);
        if (stamp !== undefined) stamps[field] = stamp;
      }
      return stamps;
    };
    const claim = (d: Doc, f: "name" | "parent", prevValue: unknown): number => {
      const s = stampsOf(d);
      if (s === null) {
        // whole-doc claim (device/legacy) - but ONLY for a CHANGED value: a
        // device echoing the value it already holds is a carry-through, not
        // an edit, and must not out-stamp a web rename/move it simply
        // hasn't applied yet (panel: web MOVE lost after any tablet edit)
        return d[f] === prevValue ? 0 : lm(d);
      }
      return s[f] ?? 0; // explicit stamps: unlisted fields claim nothing
    };
    const held = (d: Doc, f: "name" | "parent"): number => {
      // what the STORED doc defends a field with: its recorded stamp, or its
      // whole-doc lastModified for pre-#80 rows
      const s = stampsOf(d);
      return s?.[f] ?? lm(d);
    };
    const mergeDoc = (prev: Doc, next: Doc): Doc => {
      // whole-doc winner supplies everything except the per-field registers
      const base = lm(next) >= lm(prev) ? { ...next } : { ...prev };
      const out: Doc = base;
      const stamps: Stamps = {};
      for (const f of ["name", "parent"] as const) {
        const nextClaim = claim(next, f, prev[f]);
        const prevHeld = held(prev, f);
        if (nextClaim >= prevHeld) {
          out[f] = next[f];
          stamps[f] = Math.max(nextClaim, prevHeld);
        } else {
          out[f] = prev[f];
          stamps[f] = prevHeld;
        }
      }
      // Per-PAGE template registers (panel: a web template pick reverted
      // because the device's whole-doc lm outranked it and template was not
      // a register). Stamp key `t:<pageId>` in the same fieldStamps object;
      // web setPageTemplate stamps it, a stamp-less device push claims a
      // page's template only when the VALUE changed (same carry-through
      // rule as name/parent).
      type PageEnt = { id?: unknown; template?: unknown };
      const pagesOf = (d: Doc): Map<string, PageEnt> => {
        const arr = (d as { pages?: PageEnt[] }).pages;
        const m = new Map<string, PageEnt>();
        if (Array.isArray(arr))
          for (const p of arr)
            if (p && typeof p.id === "string") m.set(p.id, p);
        return m;
      };
      const rawStamps = (d: Doc): Record<string, unknown> =>
        ((d as { fieldStamps?: unknown }).fieldStamps ?? {}) as Record<string, unknown>;
      const tplStamp = (d: Doc, pid: string): number | undefined => {
        const v = rawStamps(d)[`t:${pid}`];
        return typeof v === "number" && Number.isFinite(v) ? v : undefined;
      };
      const prevPages = pagesOf(prev);
      const nextPages = pagesOf(next);
      const basePages = pagesOf(out);
      const allStamps = stamps as unknown as Record<string, number>;
      for (const [pid, basePage] of basePages) {
        const pv = prevPages.get(pid)?.template;
        const nv = nextPages.get(pid)?.template;
        const prevHeld = tplStamp(prev, pid) ?? lm(prev);
        const nextClaim =
          stampsOf(next) === null
            ? nv !== undefined && nv !== pv
              ? lm(next)
              : 0
            : (tplStamp(next, pid) ?? 0);
        if (nextClaim >= prevHeld && nv !== undefined) {
          basePage.template = nv;
          allStamps[`t:${pid}`] = Math.max(nextClaim, prevHeld);
        } else if (pv !== undefined) {
          basePage.template = pv;
          allStamps[`t:${pid}`] = prevHeld;
        }
      }
      (out as { fieldStamps?: Stamps }).fieldStamps = stamps;
      // the merged doc's lastModified is the max both sides saw, so the
      // daemon's device-ward apply (per-doc, single stamp) always fires
      out.lastModified = Math.max(lm(prev), lm(next));
      return out;
    };

    const merged = new Map<string, Doc>();
    for (const d of stored) {
      if (isDoc(d)) merged.set(d.id, d);
    }
    const incomingIds = new Set<string>();
    for (const d of incoming) {
      incomingIds.add(d.id);
      const prev = merged.get(d.id);
      merged.set(d.id, prev ? mergeDoc(prev, d) : d);
    }
    if (deviceKey && incoming.length > 0) {
      // MULTI-TABLET deletion authority: a device may only delete docs it
      // previously REPORTED having (its persisted manifest). The old reading
      // ("absent from my tree = deleted on the tablet") was only sound with
      // exactly one tablet - a second tablet's first push would have wiped
      // every doc the first one made. Deletions become TOMBSTONES
      // (deleted:true, LWW-stamped) instead of row removals, so they
      // propagate to sibling tablets (daemon moves the doc to trash) and a
      // stale sibling pushing an old copy cannot resurrect them (mergeDoc's
      // whole-doc LWW keeps the newer tombstone). The EMPTY-push guard
      // stays: never wipe the library from one malformed PUT.
      //
      // First push from a device with no manifest deletes NOTHING (it never
      // reported anything) - this also covers the upgrade from the
      // pre-manifest schema: one missed deletion window, then normal.
      //
      // create:true docs stay protected as before: web-created, not yet
      // materialized on this tablet, absent by definition.
      const manifest = this.deviceManifest(userId, deviceKey);
      // NO upgrade seeding (re-audit panel): seeding a fresh manifest from
      // the full cloud tree let the FIRST post-upgrade push (the daemon's
      // startup push runs before any pull materializes sibling docs)
      // tombstone another tablet's documents. A device with no manifest
      // deletes nothing, period. The cost: a doc deleted on-tablet during
      // the upgrade window lingers in the cloud - visibly, where the user
      // can remove it - and it can never re-materialize on the tablet
      // because the create annotation requires the doc to be backed by
      // SOME device manifest or an explicit web create.
      // EXCLUDED docs are also absent from the daemon's push (it filters
      // them), but exclusion means "keep off the cloud", NEVER "deleted":
      // tombstoning one would propagate a TRASH to the tablet that still
      // has it. Excluded absences drop the cloud row (the old hide
      // behavior); only non-excluded absences are real deletions.
      const excludedIds = new Set(this.getSyncExclusions(userId));
      for (const [id, doc] of [...merged.entries()]) {
        if (incomingIds.has(id)) continue;
        if ((doc as { create?: unknown }).create === true) continue;
        if ((doc as { deleted?: unknown }).deleted === true) continue;
        if (!manifest.has(id)) continue;
        if (excludedIds.has(id)) {
          merged.delete(id); // hidden, not deleted
          continue;
        }
        (doc as { deleted?: boolean }).deleted = true;
        doc.lastModified = Math.max(Date.now(), lm(doc) + 1);
      }
      this.putDeviceManifest(
        userId,
        deviceKey,
        [...incomingIds],
      );
    }

    // Clamp cycles/dangling parents to root. Parent chains are short (folder
    // nesting), so a per-doc walk with a seen-set is plenty.
    const TERMINAL = new Set(["", "trash"]);
    for (const d of merged.values()) {
      const seen = new Set<string>();
      let p = typeof d.parent === "string" ? d.parent : "";
      let clamp = false;
      while (!TERMINAL.has(p)) {
        // a TOMBSTONED parent is gone for navigation purposes: the web
        // filters it out, so a live child pointing at it rendered NOWHERE
        // (unreachable ghost). Clamp to root exactly like a missing parent.
        const parent = merged.get(p);
        if (seen.has(p) || !parent || (parent as { deleted?: unknown }).deleted === true) {
          clamp = true;
          break;
        }
        seen.add(p);
        const next = merged.get(p)!.parent;
        p = typeof next === "string" ? next : "";
      }
      if (clamp) d.parent = "";
    }

    const json = JSON.stringify({ documents: [...merged.values()] });
    this.putDocuments(userId, json);
    return json;
  }

  /** True when ANY device's manifest contains this doc (device-backed). */
  docKnownToSomeDevice(userId: string, doc: string): boolean {
    const row = this.db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) as n FROM device_doc_manifests WHERE user_id=? AND doc=?",
      )
      .get(userId, doc);
    return (row?.n ?? 0) > 0;
  }

  /** Doc ids this device last reported having (empty set = never pushed). */
  deviceManifest(userId: string, deviceKey: string): Set<string> {
    const rows = this.db
      .query<{ doc: string }, [string, string]>(
        "SELECT doc FROM device_doc_manifests WHERE user_id=? AND device=?",
      )
      .all(userId, deviceKey);
    return new Set(rows.map((r) => r.doc));
  }

  private putDeviceManifest(
    userId: string,
    deviceKey: string,
    docs: string[],
  ): void {
    this.db.transaction(() => {
      this.db.run(
        "DELETE FROM device_doc_manifests WHERE user_id=? AND device=?",
        [userId, deviceKey],
      );
      const ins = this.db.query(
        "INSERT OR IGNORE INTO device_doc_manifests (user_id, device, doc) VALUES (?,?,?)",
      );
      for (const d of docs) ins.run(userId, deviceKey, d);
    })();
  }

  changesSince(userId: string, seq: number): ChangeRow[] {
    return this.db
      .query(
        `SELECT seq, doc, page, revision, origin_client as originClientId
                     FROM changes WHERE user_id=? AND seq>? ORDER BY seq ASC LIMIT 500`,
      )
      .all(userId, seq) as ChangeRow[];
  }

  // ----- op + snapshot channels (#45) -----
  // The cloud relays opaque op/snapshot bytes; it never parses or merges them
  // (merge is client-side, commutative). seq is a monotonic per-store cursor.

  /** Append a batch of opaque op blobs for a page; returns the seq range. */
  appendOps(
    user: string,
    doc: string,
    page: string,
    ops: Uint8Array[],
    author: string | null,
  ): { firstSeq: number; lastSeq: number } {
    if (ops.length === 0) {
      const last = this.latestOpSeq(user, doc, page);
      return { firstSeq: last, lastSeq: last };
    }
    const ts = Date.now();
    const insert = this.db.query(
      "INSERT INTO page_ops (user_id, doc, page, op, author, ts) VALUES (?, ?, ?, ?, ?, ?)",
    );
    let firstSeq = 0;
    let lastSeq = 0;
    this.db.transaction(() => {
      for (const op of ops) {
        const seq = insert.run(user, doc, page, op, author, ts)
          .lastInsertRowid as number;
        if (firstSeq === 0) firstSeq = seq;
        lastSeq = seq;
      }
    })();
    // Compaction trigger: fold the log into a checkpoint once THIS page has
    // COMPACT_EVERY_N_OPS un-compacted ops of its own. During page publication
    // this runs after the insert, inside the outer transaction.
    this.maybeAutoCompact(user, doc, page);
    return { firstSeq, lastSeq };
  }

  /**
   * Ops for a page with seq strictly greater than `sinceSeq`, in order, up to
   * OPS_PAGE_LIMIT. Callers page until a returned batch is shorter than the
   * limit (or the last seq reaches latestOpSeq) — the HTTP route returns the
   * current head so the client knows whether more remain. A client too far
   * behind should bootstrap from a snapshot (§3) instead of replaying.
   */
  opsSince(
    user: string,
    doc: string,
    page: string,
    sinceSeq: number,
  ): { seq: number; op: Uint8Array; author: string | null; ts: number }[] {
    const rows = this.db
      .query<
        { seq: number; op: Uint8Array; author: string | null; ts: number },
        [string, string, string, number]
      >(
        `SELECT seq, op, author, ts FROM page_ops
                 WHERE user_id=? AND doc=? AND page=? AND seq>? ORDER BY seq ASC LIMIT ${OPS_PAGE_LIMIT}`,
      )
      .all(user, doc, page, sinceSeq);
    return rows.map((r) => ({
      seq: r.seq,
      op: new Uint8Array(r.op),
      author: r.author,
      ts: r.ts,
    }));
  }

  /** Pin the rows, retention floor and checkpoint stamp to one SQLite read. */
  readOpPage(user: string, doc: string, page: string, since: number) {
    return this.db.transaction(() => {
      const floor = this.truncationFloor(user, doc, page);
      if (floor > 0 && since < floor) return { truncated: true as const, floor };
      return {
        truncated: false as const,
        floor,
        ops: this.opsSince(user, doc, page, since),
        head: this.latestOpSeq(user, doc, page),
        snapshotSeq: this.latestSnapshotSeq(user, doc, page),
      };
    })();
  }

  /** The page's truncation floor: the highest op seq retention has deleted
   *  (0 = nothing truncated — always the case for keep-all pages). An
   *  opsSince cursor BELOW the floor predates the retained log (the /ops
   *  route answers 410 so the client re-bootstraps instead of silently
   *  diverging on a gapped log); stateAt/revertTo targets below it refuse
   *  with BelowFloorError. */
  truncationFloor(user: string, doc: string, page: string): number {
    const row = this.db
      .query<
        { floor_seq: number },
        [string, string, string]
      >("SELECT floor_seq FROM page_floors WHERE user_id=? AND doc=? AND page=?")
      .get(user, doc, page);
    return row?.floor_seq ?? 0;
  }

  /** Highest op seq for a page (0 if none) — the client's resume cursor. */
  latestOpSeq(user: string, doc: string, page: string): number {
    const row = this.db
      .query<
        { s: number | null },
        [string, string, string]
      >("SELECT MAX(seq) AS s FROM page_ops WHERE user_id=? AND doc=? AND page=?")
      .get(user, doc, page);
    return row?.s ?? 0;
  }

  /** Store a compacted snapshot of a page (whole .rm bytes) on disk; returns
   *  its seq. Snapshots back op-log compaction, bootstrap, and history (§3).
   *  Crash-safe like putFile: write disk FIRST (a random-hashed name, so we
   *  don't need the seq), then a single INSERT with the final path. A crash
   *  before the INSERT leaves only an orphan file (harmless garbage), never an
   *  empty-path row.
   *
   *  `atSeq` (optional): the op-log seq the caller reconstructed `bytes` at.
   *  When supplied it is pinned as this snapshot's op_seq (instead of re-reading
   *  the live head), and we assert the live head still equals it — proving bytes
   *  and pinned op_seq come from the same value and failing loudly if an
   *  appendOps ever interleaves. Omit it to pin "the current head". */
  putSnapshot(
    user: string,
    doc: string,
    page: string,
    bytes: Uint8Array,
    revert = false,
    atSeq?: number,
  ): number {
    // pin the op-log head this snapshot folds in: reconstruct replays only
    // ops with seq > op_seq. Captured BEFORE the INSERT so a concurrent
    // appendOps can't be double-counted (worse case it replays once, which
    // is idempotent).
    //
    // `atSeq`: callers that reconstructed the bytes AT a specific seq (compact
    // folds stateAt(head); revertTo pins stateAt(target) at the post-marker
    // head) MUST pass that seq so the pinned op_seq is provably taken from the
    // SAME value the bytes were built from. We then assert the live head still
    // equals it: this guarantees the (bytes @ atSeq, op_seq = atSeq) pair is
    // consistent and fails loudly if an interleaving appendOps ever lands
    // between the caller's reconstruct and this INSERT (today impossible —
    // synchronous SQLite/Bun, no await — but the assert makes the invariant
    // enforced, not merely documented). Callers that omit atSeq accept
    // "whatever the current head is" (e.g. applyDevicePut's glyph/image
    // snapshot fallback, taken right after its own appendOps).
    const currentHead = this.latestOpSeq(user, doc, page);
    if (atSeq !== undefined && atSeq !== currentHead) {
      throw new Error(
        `putSnapshot: op-log head moved between reconstruct and INSERT ` +
          `(expected op_seq=${atSeq}, live head=${currentHead}) for ` +
          `${user}/${doc}/${page}; snapshot bytes would not match pinned op_seq`,
      );
    }
    const opSeq = atSeq ?? currentHead;
    const seq = this.insertSnapshotRow(user, doc, page, bytes, opSeq, revert);
    if (!this.stagedPageFiles) this.pruneSupersededSnapshots(user, doc, page);
    return seq;
  }

  private pruneSupersededSnapshots(user: string, doc: string, page: string): void {
    // prune superseded FAITHFUL checkpoints beyond the latest SNAPSHOT_KEEP:
    // delete the rows before removing their now-unreferenced files.
    // Revert markers (revert=1) are EXEMPT — they are authoritative for the
    // op range they pin (snapshotForSeq/live both select them), so churning
    // out a revert would silently UN-REVERT the live head and corrupt
    // time-travel of any seq at/after that revert. Only revert=0 rows count
    // toward the KEEP window and are eligible for deletion; every revert
    // marker is retained (F3 owns any eventual compaction).
    // The truncation-BOUNDARY checkpoint (op_seq == the page's floor, #52) is
    // exempt too: it is the ONLY base for time-travel targets in
    // [floor, next checkpoint) after retention deleted their replay range, so
    // pruning it would silently break mid-window stateAt. It becomes prunable
    // again once a later truncation raises the floor past it.
    const stale = this.db
      .query<
        { seq: number; path: string },
        [string, string, string, string, string, string, number]
      >(
        `SELECT seq, path FROM page_snapshots
                 WHERE user_id=? AND doc=? AND page=? AND revert=0
                   AND op_seq <> COALESCE(
                     (SELECT floor_seq FROM page_floors WHERE user_id=? AND doc=? AND page=?), -1)
                 ORDER BY seq DESC LIMIT -1 OFFSET ?`,
      )
      .all(user, doc, page, user, doc, page, SNAPSHOT_KEEP);
    if (stale.length > 0) {
      this.db.run(
        `DELETE FROM page_snapshots WHERE seq IN (${stale.map(() => "?").join(",")})`,
        stale.map((o) => o.seq),
      );
    }
    for (const old of stale) {
      if (this.retiredPageFiles) this.retiredPageFiles.push(old.path);
      else this.removeSnapshotFile(old.path);
    }
  }

  /** Write snapshot bytes to disk and INSERT the row pinned at `opSeq`;
   *  returns its seq. Crash-safe like putSnapshot (disk first, then one
   *  INSERT). Shared by putSnapshot (head-pinned, asserted, pruning) and
   *  compact's truncation-boundary checkpoint (pinned at a PAST op seq, so
   *  putSnapshot's live-head assertion must not apply). */
  private insertSnapshotRow(
    user: string,
    doc: string,
    page: string,
    bytes: Uint8Array,
    opSeq: number,
    revert: boolean,
  ): number {
    const dir = join(this.filesDir, "snapshots");
    mkdirSync(dir, { recursive: true });
    const path = join(
      dir,
      sha256hex(
        new TextEncoder().encode(
          `${user} ${doc} ${page} ${crypto.randomUUID()}`,
        ),
      ),
    );
    try {
      writeFileSync(path, bytes);
      const recovery = this.db.query("SELECT 1 FROM recovery_imports WHERE user_id=?").get(user);
      const seq = this.db
        .query(
          "INSERT INTO page_snapshots (user_id, doc, page, path, size, ts, op_seq, revert, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          user,
          doc,
          page,
          path,
          bytes.length,
          Date.now(),
          opSeq,
          revert ? 1 : 0,
          recovery ? sha256hex(bytes) : null,
        ).lastInsertRowid as number;
      this.stagedPageFiles?.push(path);
      return seq;
    } catch (error) {
      this.removeSnapshotFile(path);
      throw error;
    }
  }

  /** The latest snapshot for a page (seq + op_seq cursor + bytes), or null.
   *  reconstruct = these bytes + opsSince(opSeq). */
  latestSnapshot(
    user: string,
    doc: string,
    page: string,
    requireAvailable = false,
  ): { seq: number; opSeq: number; revert: boolean; bytes: Uint8Array } | null {
    const snap = this.latestSnapshotReference(user, doc, page, requireAvailable);
    if (!snap) return null;
    const { readBytes, complete: _complete, ...metadata } = snap;
    return { ...metadata, bytes: readBytes() };
  }

  private existingSnapshotPath(storedPath: string): string | null {
    const path = this.storedBlobPath(storedPath, "snapshots");
    return path && existsSync(path) ? path : null;
  }

  /** Checkpoint metadata and a reader bound to that checkpoint's file. */
  latestSnapshotReference(
    user: string,
    doc: string,
    page: string,
    requireAvailable = false,
  ): { seq: number; opSeq: number; revert: boolean; complete: boolean; readBytes: () => Uint8Array } | null {
    const row = this.latestSnapshotRow(user, doc, page);
    if (!row) return null;
    const path = this.existingSnapshotPath(row.path);
    if (!path) {
      if (requireAvailable) throw new SnapshotUnavailable();
      return null;
    }
    if (requireAvailable) {
      try {
        accessSync(path, fsConstants.R_OK);
        const stat = statSync(path);
        if (!stat.isFile() || stat.size !== row.size) throw new SnapshotUnavailable();
      } catch {
        throw new SnapshotUnavailable();
      }
    }
    return {
      seq: row.seq,
      opSeq: row.op_seq,
      // a REVERT head-rewrite (#51) deliberately rewinds past ops ≤ op_seq:
      // adopters must take its overlay VERBATIM (an LWW merge would keep the
      // newer pre-revert shapes and the audit would then destroy them)
      revert: row.revert === 1,
      complete: row.complete === 1,
      readBytes: () => requireAvailable ? this.readRequiredCheckpoint(row) : new Uint8Array(readFileSync(path)),
    };
  }

  private latestSnapshotRow(user: string, doc: string, page: string) {
    return this.db
      .query<
        { seq: number; op_seq: number; revert: number; path: string; size: number; complete: number; sha256: string | null },
        [string, string, string]
      >(
        `SELECT s.seq, s.op_seq, s.revert, s.path, s.size, s.sha256,
           (s.op_seq >= COALESCE((SELECT floor_seq FROM page_floors
             WHERE user_id=?1 AND doc=?2 AND page=?3), 0)
            AND NOT EXISTS (SELECT 1 FROM page_ops
             WHERE user_id=?1 AND doc=?2 AND page=?3 AND seq>s.op_seq)) AS complete
         FROM page_snapshots s
         WHERE s.user_id=?1 AND s.doc=?2 AND s.page=?3 ORDER BY s.seq DESC LIMIT 1`,
      )
      .get(user, doc, page);
  }

  // ----- history + time-travel + revert (#51, D3: "snapshot + N diffs") -----
  // The op log (page_ops) + checkpoints (page_snapshots) already ARE the full
  // history: no separate event store. Reconstruct at op seq T = the latest
  // snapshot with op_seq <= T + replay the ops in (snapshot.op_seq, T]. This
  // reuses the exact bridge logic (reconstructRm / applyRemoteOps). We store
  // everything and never delete on revert — truncation/compaction is F3.

  /**
   * The page's edit timeline: every op and every checkpoint, in chronological
   * order (by wall-clock ts, then op-seq to break ties).
   *  - kind 'op': an edit op (seq = its page_ops seq); a valid stateAt/revertTo
   *    target. `author` is the op's author.
   *  - kind 'revert': the no-op marker a revertTo appended (author REVERT_AUTHOR)
   *    — the distinguishable "a revert happened here" point on the timeline.
   *  - kind 'snapshot': where a checkpoint sits on the op timeline (its op_seq);
   *    it shares a seq with the op it folds in but is ordered after it. `author`
   *    is null for snapshots.
   *
   * `limit` bounds the response (free public service; keep-all logs grow
   * without bound): the NEWEST `limit` ops are returned, still in ascending
   * order. Snapshots are few (SNAPSHOT_KEEP + revert pins) and always included.
   */
  historyPoints(
    user: string,
    doc: string,
    page: string,
    limit = 1000,
  ): {
    seq: number;
    ts: number;
    kind: "op" | "revert" | "snapshot";
    author: string | null;
    /** snapshot points only: the snapshot's OWN seq — the handle a
     *  revertToSnapshot restore uses (op seqs cannot address blob-era
     *  checkpoints, which all share op_seq 0). */
    snapSeq?: number;
    /** snapshot points only: true when this snapshot was pinned BY a
     *  restore (revert=1). The UI merges it with its marker op into one
     *  timeline row instead of showing a phantom extra checkpoint. */
    revertSnap?: boolean;
  }[] {
    const ops = this.db
      .query<
        { seq: number; ts: number; author: string | null },
        [string, string, string, number]
      >(
        // newest N by seq, re-ascended so the timeline reads oldest->newest
        `SELECT seq, ts, author FROM (
           SELECT seq, ts, author FROM page_ops
           WHERE user_id=? AND doc=? AND page=? ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq ASC`,
      )
      .all(user, doc, page, limit)
      .map((r) => ({
        seq: r.seq,
        ts: r.ts,
        kind: (r.author === REVERT_AUTHOR ? "revert" : "op") as "op" | "revert",
        author: r.author,
      }));
    const snaps = this.db
      .query<
        { seq: number; op_seq: number; ts: number; revert: number },
        [string, string, string]
      >(
        "SELECT seq, op_seq, ts, revert FROM page_snapshots WHERE user_id=? AND doc=? AND page=? ORDER BY seq ASC",
      )
      .all(user, doc, page)
      .map((r) => ({
        seq: r.op_seq,
        ts: r.ts,
        kind: "snapshot" as const,
        author: null,
        snapSeq: r.seq,
        revertSnap: r.revert === 1,
      }));
    // Merge into one timeline. Primary key: ts (real chronology). Tie-break:
    // op seq, then kind (an op/revert marker sorts before a snapshot folding
    // in the same head, since the snapshot is written after the op it captures).
    const rank = (k: "op" | "revert" | "snapshot") =>
      k === "snapshot" ? 1 : 0;
    return [...ops, ...snaps].sort(
      (a, b) => a.ts - b.ts || a.seq - b.seq || rank(a.kind) - rank(b.kind),
    );
  }

  /** The snapshot best-suited to reconstruct op seq `target`: the newest one
   *  (by seq) whose folded-in op head (op_seq) is <= target. Null when none
   *  qualifies (replay from an empty doc).
   *
   *  Revert snapshots are NOT skipped — they are authoritative checkpoints for
   *  any target at/after the op head they pin (op_seq). This is the SAME
   *  selection rule the live path uses (latestSnapshot = newest by seq, no
   *  revert filter), so stateAt(head) == reconstructDevicePage(head) even after
   *  a revert. A revert pins the past state at the current head H; for target
   *  >= H the revert snapshot is the base and only ops in (H, target] replay,
   *  reproducing the reverted state (plus any post-revert edits) exactly as the
   *  device sees them. For target < H the revert (op_seq H) is excluded by the
   *  op_seq<=target bound, so an older faithful checkpoint + raw replay yields
   *  the truthful pre-revert state at that past op seq. */
  private snapshotForSeq(
    user: string,
    doc: string,
    page: string,
    target: number,
  ): { opSeq: number; bytes: Uint8Array } | null {
    const row = this.db
      .query<
        { op_seq: number; path: string; size: number; sha256: string | null },
        [string, string, string, number]
      >(
        `SELECT op_seq, path, size, sha256 FROM page_snapshots
                 WHERE user_id=? AND doc=? AND page=? AND op_seq<=? ORDER BY seq DESC LIMIT 1`,
      )
      .get(user, doc, page, target);
    if (!row) return null;
    return { opSeq: row.op_seq, bytes: this.readRequiredCheckpoint(row) };
  }

  private readRequiredCheckpoint(row: { path: string; size: number; sha256: string | null }): Uint8Array {
    try {
      const path = this.existingSnapshotPath(row.path);
      if (!path) throw new Error("missing checkpoint file");
      const bytes = new Uint8Array(readFileSync(path));
      if (bytes.length !== row.size || (row.sha256 && sha256hex(bytes) !== row.sha256)) {
        throw new Error("checkpoint integrity mismatch");
      }
      return bytes;
    } catch (cause) {
      throw new CheckpointUnavailableError(cause);
    }
  }

  private decodeHistoryCheckpoint(bytes: Uint8Array): ReturnType<typeof decodeSnapshot> {
    try {
      const checkpoint = decodeSnapshot(bytes);
      if (!Array.isArray(checkpoint.overlay?.shapes)) throw new Error("invalid checkpoint overlay");
      return checkpoint;
    } catch (cause) {
      throw new CheckpointUnavailableError(cause);
    }
  }

  /** Ops for a page in the seq window (after, target] in order (bounded replay
   *  window for time-travel; unlike opsSince this is closed at the top). */
  private opsInRange(
    user: string,
    doc: string,
    page: string,
    after: number,
    target: number,
  ): Op[] {
    return this.db
      .query<{ op: Uint8Array }, [string, string, string, number, number]>(
        `SELECT op FROM page_ops
                 WHERE user_id=? AND doc=? AND page=? AND seq>? AND seq<=? ORDER BY seq ASC`,
      )
      .all(user, doc, page, after, target)
      .map((r) => decodeOp(new Uint8Array(r.op)));
  }

  /**
   * Reconstruct the page's full state (.rm bytes + overlay) at op seq `target`:
   * the latest snapshot with op_seq <= target (revert snapshots included — see
   * snapshotForSeq), then replay the ops in (snapshot.op_seq, target]. Identical
   * materialization AND snapshot-selection to the device bridge (reconstructRm
   * for ink; foldOverlayOps for the object ops), so stateAt(head) equals
   * reconstructDevicePage(head) on the ink layer — INCLUDING after a revert, and
   * including a fresh edit made after a revert (both use the newest snapshot,
   * revert or not, so they cannot diverge). target=0 yields the empty/base
   * state. Ops with seq > target are IGNORED (the "at a past point" contract),
   * which is what makes revert possible.
   *
   * Throws BelowFloorError for a target BELOW the page's truncation floor
   * (#52): retention deleted the ops that would reconstruct it, so any answer
   * would be silently wrong. Targets AT/ABOVE the floor are byte-correct — the
   * truncation-boundary checkpoint compact() pins at the floor guarantees a
   * base whose replay range is fully retained. Keep-all pages (floor 0, the
   * default) are unaffected.
   */
  /** The live overlay WITHOUT the ink reconstruction: GET /overlay only
   *  needs the snapshot's overlay + the object ops after it, and stateAt's
   *  reconstructRm over the same range was pure throwaway work on every
   *  overlay read of a heavy page. */
  overlayAtHead(user: string, doc: string, page: string, requireAvailable = false): OverlayDocument {
    const snap = this.latestSnapshot(user, doc, page, requireAvailable);
    const base = snap ? decodeSnapshot(snap.bytes) : null;
    const overlay: OverlayDocument = base?.overlay
      ? (JSON.parse(JSON.stringify(base.overlay)) as OverlayDocument)
      : { shapes: [] };
    const ops = this.opsInRange(
      user, doc, page, snap?.opSeq ?? 0, this.latestOpSeq(user, doc, page),
    );
    foldOverlayOps(overlay, ops);
    return overlay;
  }

  stateAt(
    user: string,
    doc: string,
    page: string,
    target: number,
  ): { rm: Uint8Array; overlay: OverlayDocument } {
    const floor = this.truncationFloor(user, doc, page);
    if (floor > 0 && target < floor) throw new BelowFloorError(floor, target);
    const snap = this.snapshotForSeq(user, doc, page, target);
    if (floor > 0 && (!snap || snap.opSeq < floor)) throw new CheckpointUnavailableError();
    const base = snap ? this.decodeHistoryCheckpoint(snap.bytes) : null;
    const ops = this.opsInRange(user, doc, page, snap?.opSeq ?? 0, target);
    const rm = reconstructRm(base?.rm ?? null, ops, DEVICE_BRIDGE_AUTHOR);
    // Rebuild overlay from the snapshot's overlay + the object ops only — the
    // ink was already materialized above, so no throwaway doc / double apply.
    const overlay: OverlayDocument = base?.overlay
      ? JSON.parse(JSON.stringify(base.overlay))
      : { shapes: [] };
    foldOverlayOps(overlay, ops);
    return { rm, overlay };
  }

  /**
   * Revert the live head to a past op seq `target` WITHOUT losing history.
   *
   * Two coupled writes make the reverted state authoritative for BOTH the live
   * device path and time-travel, using the ONE snapshot-selection rule
   * (snapshotForSeq/latestSnapshot both pick the newest snapshot by seq):
   *
   *  1) Append a no-op revert MARKER op, advancing the op head from H to H'.
   *     The marker carries no ink/overlay payload, so reconstruct ignores it —
   *     it only reserves a seq. This is what lets the future be recovered: the
   *     ops in (target, H] are RETAINED and now sit strictly below H', so
   *     reverting the revert (revertTo(H)) raw-replays them back.
   *  2) Publish a revert snapshot of stateAt(target) pinned at the NEW head H'
   *     (revert=1: authoritative at/after H', exempt from SNAPSHOT_KEEP pruning).
   *
   * Result: reconstruct at head H' = this snapshot + no ops = stateAt(target),
   * so live == stateAt(H') == the reverted state, and a fresh edit after the
   * revert (an op at H'+1) is reflected identically by both paths. We pass H'
   * (the post-marker head) to `putSnapshot` as its pinned op_seq, so the marker
   * (written first) is folded into the snapshot's op_seq. `opHead` returns the head the
   * revert was taken AT (H, before the marker) — the point on the timeline the
   * user reverted from. No-op-safe: reverting to the current head re-pins the
   * present (and raw-replay of the retained log still yields it). Refuses a
   * target below the truncation floor (BelowFloorError, via stateAt) — the
   * ops to rebuild it were deleted by retention (#52).
   */
  revertTo(
    user: string,
    doc: string,
    page: string,
    target: number,
  ): { snapshotSeq: number; opHead: number; newHead: number } {
    return this.publishPage(user, doc, page, () => {
      const opHead = this.latestOpSeq(user, doc, page);
      const past = this.stateAt(user, doc, page, target);
      // (1) advance the head with the marker op, so the pre-revert ops are
      // strictly below the revert snapshot's op_seq (recoverable future) and
      // the revert is a distinct, non-deletable point in the op timeline.
      this.appendOps(user, doc, page, [revertMarkerOp(target)], REVERT_AUTHOR);
      // (2) pin the past state at the NEW head (folds in the marker). revert=1:
      // authoritative for time-travel/live at any seq >= this head AND exempt
      // from SNAPSHOT_KEEP pruning, so the revert's outcome can't be churned
      // away by later faithful checkpoints (which would silently un-revert).
      // Pass newHead as atSeq: the bytes are stateAt(target) but this checkpoint
      // stands in for the timeline AT the post-marker head, so op_seq must pin to
      // that head. putSnapshot asserts the live head still == newHead at INSERT,
      // catching any appendOps that interleaved between the marker append and here
      // (which would otherwise leave a gap op unfolded above this checkpoint).
      const newHead = this.latestOpSeq(user, doc, page);
      const snapshotSeq = this.putSnapshot(
        user,
        doc,
        page,
        encodeSnapshot(past.rm, past.overlay),
        true,
        newHead,
      );
      return { snapshotSeq, opHead, newHead };
    });
  }

  /** Raw container bytes by the checkpoint's own seq, not op_seq. Bridge
   *  callers can fall back when a file is gone; history restoration cannot. */
  getSnapshotBytes(
    user: string,
    doc: string,
    page: string,
    snapSeq: number,
    verifyHistory = false,
  ): Uint8Array | null {
    const row = this.db
      .query<{ path: string; size: number; sha256: string | null }, [string, string, string, number]>(
        "SELECT path, size, sha256 FROM page_snapshots WHERE user_id=? AND doc=? AND page=? AND seq=?",
      )
      .get(user, doc, page, snapSeq);
    if (!row) return null;
    if (verifyHistory) {
      const bytes = this.readRequiredCheckpoint(row);
      try {
        const { rm } = this.decodeHistoryCheckpoint(bytes);
        RmDocument.parse(rm);
      } catch (cause) {
        throw new CheckpointUnavailableError(cause);
      }
      return bytes;
    }
    const path = this.existingSnapshotPath(row.path);
    return path ? new Uint8Array(readFileSync(path)) : null;
  }

  /**
   * Revert the live head to a stored SNAPSHOT (addressed by its own seq), not
   * to an op seq. This exists because op seqs cannot address most of a
   * tablet-authored page's history: every daemon blob push folds a snapshot at
   * the then-current op head, so a page only ever written from the tablet has
   * MANY distinct states all sharing op_seq (typically 0) — under revertTo
   * they are indistinguishable, and stateAt always picks the NEWEST of them.
   * Addressing the snapshot row directly restores the exact bytes that
   * checkpoint captured.
   *
   * Mechanics mirror revertTo: append a no-op marker (head H -> H'), then pin
   * the snapshot's bytes as a revert=1 checkpoint at H'. No op replay happens,
   * so the truncation floor is irrelevant here — a retained snapshot is
   * restorable even when the ops around it were truncated. Returns null when
   * the snapshot row no longer exists (pruned). A known damaged checkpoint is an error.
   */
  revertToSnapshot(
    user: string,
    doc: string,
    page: string,
    snapSeq: number,
  ): { snapshotSeq: number; opHead: number; newHead: number } | null {
    return this.publishPage(user, doc, page, () => {
      const bytes = this.getSnapshotBytes(user, doc, page, snapSeq, true);
      if (!bytes) return null;
      const opHead = this.latestOpSeq(user, doc, page);
      this.appendOps(user, doc, page, [revertMarkerOp(opHead)], REVERT_AUTHOR);
      const newHead = this.latestOpSeq(user, doc, page);
      const snapshotSeq = this.putSnapshot(user, doc, page, bytes, true, newHead);
      return { snapshotSeq, opHead, newHead };
    });
  }

  // ----- log compaction / retention (F3, D3 §6) -----
  // Fold ops <= H into a fresh checkpoint pinned at H, so reconstruct reads
  // (checkpoint + a short op tail) instead of the whole log. Truncation is a
  // config flip (RETENTION_KEEP_ALL=false), not a rewrite, and is SAFE (#52):
  // it pins a boundary checkpoint + persists the truncation floor, so clients
  // and history are signalled (410 / BelowFloorError) instead of silently
  // diverging. The DEFAULT keeps everything (create the checkpoint, delete NO
  // page_ops), so F2 history/time-travel/revert reaches the oldest state.

  /**
   * Compact a page's op log by folding every op with seq <= H (the current op
   * head) into ONE fresh faithful checkpoint pinned at H, where
   * H = latestOpSeq at call time. The checkpoint is exactly stateAt(H) run
   * through encodeSnapshot, so it materializes byte-identically to a full
   * replay.
   *
   * Invariant (the point of compaction): reconstruct(LATEST snapshot +
   * opsSince(op_seq)) is byte-identical before and after this call — the live
   * device path (reconstructDevicePage) and any time-travel target >= H.
   * Proof: the new checkpoint pins op_seq=H and its bytes == stateAt(H), and
   * snapshotForSeq/latestSnapshot both pick the newest snapshot by seq; for any
   * target >= H the base becomes this checkpoint and only ops in (H, target]
   * replay — the same result as before, since replaying (0, H] then (H, target]
   * folds into the checkpoint.
   *
   * Time-travel to a target < H: the checkpoint (op_seq H) is excluded by the
   * op_seq<=target bound, so snapshotForSeq falls back to an OLDER base + a raw
   * replay of (olderBase.opSeq, target]. In KEEP-ALL mode every such op is
   * retained, so those targets are byte-identical too. In WINDOW mode targets
   * at/above the truncation FLOOR stay byte-identical (the boundary checkpoint
   * below guarantees their base); targets below the floor are REFUSED
   * (BelowFloorError / HTTP 410), never answered with a wrong reconstruct.
   *
   * Retention (D3 §6, #52):
   *  - keep-all (RETENTION_KEEP_ALL / opts.keepAll, the DEFAULT): create the
   *    checkpoint and delete NO page_ops. Full history retained; F2
   *    (history/time-travel/revert) still reaches the oldest state, at every seq.
   *  - window (keepAll=false, OPT-IN): delete ops strictly older than
   *    cutoff = max(0, H - keepRecentOps), guarded by TWO coupled writes:
   *     1. a BOUNDARY checkpoint of stateAt(floor) pinned at the floor (the
   *        highest seq being deleted), written BEFORE anything is deleted and
   *        exempt from SNAPSHOT_KEEP pruning while it IS the floor — so every
   *        surviving target >= floor keeps a base whose replay range is fully
   *        retained (mid-window targets included), and
   *     2. the persisted floor (page_floors), set ATOMICALLY with the DELETE —
   *        the /ops gap signal (410 to a cursor below it) and the stateAt/
   *        revertTo clamp both read it.
   *    The kept tail [cutoff, H] still lets a lagging client replay instead of
   *    re-bootstrapping; only cursors/targets below the floor are affected.
   *
   * No-op when there are no ops (nothing to fold). Returns the checkpoint seq
   * (or the existing head snapshot when nothing was folded) plus how many ops
   * were truncated (0 in keep-all mode) and the op head it compacted to.
   */
  compact(
    user: string,
    doc: string,
    page: string,
    opts: { keepAll?: boolean; keepRecentOps?: number } = {},
  ): { snapshotSeq: number | null; head: number; opsTruncated: number } {
    const head = this.latestOpSeq(user, doc, page);
    if (head === 0) {
      // no ops to fold — nothing to compact.
      return { snapshotSeq: null, head, opsTruncated: 0 };
    }
    // Plan truncation (window mode) BEFORE any checkpoint is written, while
    // the log is intact:
    //  - cutoff: keep the most-recent `keepRecentOps` (a lagging client can
    //    still replay the tail instead of re-bootstrapping). The head
    //    checkpoint written below pins op_seq=head >= cutoff, so the invariant
    //    "never delete at/after the newest snapshot's op_seq" holds by
    //    construction.
    //  - floor: the HIGHEST page op seq that will be deleted (page seqs
    //    interleave in the store-wide log, so this is NOT simply cutoff-1).
    //  - boundary state: stateAt(floor), reconstructable now (full log) but not
    //    after the DELETE — pinned as a checkpoint at the floor so every
    //    time-travel target >= floor keeps a fully-retained replay base.
    const keepAll = opts.keepAll ?? RETENTION_KEEP_ALL;
    const keepRecentOps = opts.keepRecentOps ?? RETENTION_KEEP_RECENT_OPS;
    const cutoff = keepAll ? 0 : Math.max(0, head - keepRecentOps);
    let floor: number | null = null;
    if (cutoff > 0) {
      floor = (
        this.db
          .query<
            { m: number | null },
            [string, string, string, number]
          >("SELECT MAX(seq) AS m FROM page_ops WHERE user_id=? AND doc=? AND page=? AND seq<?")
          .get(user, doc, page, cutoff) as { m: number | null }
      ).m;
    }
    // Validate both required bases before writing anything. Inserting the
    // boundary first would also shadow the head's distinct, newer checkpoint.
    const state = this.stateAt(user, doc, page, head);
    if (floor !== null) {
      const boundary = this.stateAt(user, doc, page, floor);
      // insertSnapshotRow, not putSnapshot: this checkpoint is deliberately
      // pinned at a PAST seq (the head assertion must not apply), and it is
      // written FIRST so the head checkpoint below stays the newest-by-seq
      // snapshot (latestSnapshot / the live path are unchanged).
      this.insertSnapshotRow(
        user,
        doc,
        page,
        encodeSnapshot(boundary.rm, boundary.overlay),
        floor,
        false,
      );
    }
    // Fold ops (0, head] into a fresh faithful checkpoint == stateAt(head).
    // We reconstruct the bytes at `head`, then pin the snapshot's op_seq to that
    // same `head` (passed as atSeq). putSnapshot asserts the live head still ==
    // head at INSERT: if any appendOps ever interleaved between stateAt(head)
    // here and the INSERT, the checkpoint bytes (stateAt(head)) and its pinned
    // op_seq would disagree and silently drop the interleaved op from
    // reconstruct — so we fail loudly instead. (No interleave is possible today:
    // SQLite/Bun runs synchronously with no await on this path.)
    const snapshotSeq = this.putSnapshot(
      user,
      doc,
      page,
      encodeSnapshot(state.rm, state.overlay),
      false,
      head,
    );

    if (floor === null) {
      // keep-everything (or nothing below the cutoff): no page_ops removed.
      return { snapshotSeq, head, opsTruncated: 0 };
    }

    // Truncate: delete ops STRICTLY older than the cutoff (the op at
    // seq=cutoff is the base a tail replay could start just after, so keep
    // it) and persist the floor IN THE SAME TRANSACTION — a floor lagging the
    // DELETE would be exactly the silent-gap landmine the floor exists to
    // prevent. max() keeps the floor monotonic.
    let opsTruncated = 0;
    this.db.transaction(() => {
      this.db.run(
        "DELETE FROM page_ops WHERE user_id=? AND doc=? AND page=? AND seq<?",
        [user, doc, page, cutoff],
      );
      // Bun's run().changes includes updates made by the usage trigger.
      opsTruncated = this.db
        .query<{ n: number }, []>("SELECT changes() AS n")
        .get()!.n;
      this.db.run(
        `INSERT INTO page_floors (user_id, doc, page, floor_seq) VALUES (?, ?, ?, ?)
                 ON CONFLICT(user_id, doc, page) DO UPDATE SET
                   floor_seq = max(floor_seq, excluded.floor_seq)`,
        [user, doc, page, floor],
      );
    })();
    return { snapshotSeq, head, opsTruncated };
  }

  /**
   * Compact when THIS page has accumulated COMPACT_EVERY_N_OPS ops that are not
   * yet folded into its latest snapshot. Counts the page's OWN un-compacted ops
   * (seq > latest snapshot's op_seq) — NOT the global page_ops autoincrement
   * value, which is store-wide and would fire on a page after a single op just
   * because other pages advanced the global seq. Called from appendOps after the
   * batch is inserted. Failures are best effort unless SQLite also rolls back
   * the enclosing publication.
   */
  private maybeAutoCompact(user: string, doc: string, page: string): void {
    if (COMPACT_EVERY_N_OPS <= 0) return;
    const snap = this.latestSnapshot(user, doc, page);
    const sinceSeq = snap ? snap.opSeq : 0;
    const uncompacted = (
      this.db
        .query<{ c: number }, [string, string, string, number]>(
          `SELECT COUNT(*) AS c FROM page_ops
                 WHERE user_id=? AND doc=? AND page=? AND seq>?`,
        )
        .get(user, doc, page, sinceSeq) as { c: number }
    ).c;
    if (uncompacted < COMPACT_EVERY_N_OPS) return;
    const inTransaction = this.db.inTransaction;
    try {
      this.publishPage(user, doc, page, () => this.compact(user, doc, page));
    } catch (error) {
      // SQLite can roll back the whole transaction instead of the savepoint.
      // Abort publication before any later write can run in autocommit mode.
      if (inTransaction && !this.db.inTransaction) throw error;
    }
  }

  /**
   * Stable high-entropy secret for signing self-host session JWTs. Generated
   * once and persisted, so it survives restarts and is NEVER derived from the
   * login password (a low-entropy human password must not double as a signing
   * key). An operator can still pin it explicitly via WEFT_JWT_SECRET.
   */
  getOrCreateJwtSecret(): string {
    const row = this.db
      .query("SELECT value FROM config WHERE key=?")
      .get("jwt_secret") as { value: string } | null;
    if (row) return row.value;
    const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll(
      "-",
      "",
    );
    this.db.run("INSERT INTO config (key, value) VALUES (?, ?)", [
      "jwt_secret",
      secret,
    ]);
    return secret;
  }

  mintDeviceToken(userId: string, label: string): string {
    const token = `chd_${crypto.randomUUID().replaceAll("-", "")}`;
    this.db.run(
      "INSERT INTO device_tokens (token, id, user_id, label, created_at) VALUES (?,?,?,?,?)",
      [token, crypto.randomUUID(), userId, label, Date.now()],
    );
    return token;
  }

  userForDeviceToken(token: string): string | null {
    const row = this.db
      .query("SELECT user_id FROM device_tokens WHERE token=?")
      .get(token) as { user_id: string } | null;
    if (!row) return null;
    this.touchDeviceToken(token);
    return row.user_id;
  }

  /** Record last use, throttled to ~once/min so a chatty device doesn't write on
   *  every request. Called on device-token auth AND (crucially) periodically while
   *  the daemon holds its WebSocket open — the daemon authenticates ONCE at
   *  connect, so an idle-but-connected tablet was showing "days ago" even though
   *  it's alive. Also powers the UI "last used" and the stale-token prune. */
  touchDeviceToken(token: string): void {
    const now = Date.now();
    this.db.run(
      "UPDATE device_tokens SET last_used_at=? WHERE token=? AND (last_used_at IS NULL OR last_used_at < ?)",
      [now, token, now - 60_000],
    );
  }

  /** Existing relay enrollment, without reading raw device credentials. */
  hasPairedDevice(userId: string): boolean {
    return !!this.db.query("SELECT 1 FROM device_tokens WHERE user_id=? LIMIT 1").get(userId);
  }

  /** A user's paired devices. Returns the full token (owner-only session) so
   *  the UI can mask it but still offer copy; never rendered on screen raw. */
  listDeviceTokens(userId: string): {
    id: string;
    label: string;
    token: string;
    preview: string;
    createdAt: number;
    lastUsedAt: number | null;
  }[] {
    return (
      this.db
        .query(
          "SELECT token, id, label, created_at, last_used_at FROM device_tokens WHERE user_id=? ORDER BY created_at DESC",
        )
        .all(userId) as {
        token: string;
        id: string;
        label: string;
        created_at: number;
        last_used_at: number | null;
      }[]
    ).map((r) => ({
      id: r.id,
      label: r.label,
      token: r.token,
      preview: `${r.token.slice(0, 12)}…${r.token.slice(-4)}`,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  /** Revoke a device token by id. Returns the deleted RAW token (so the caller
   *  can close any live WebSocket still authenticated with it, #65), or null if
   *  no such token belonged to this user. */
  revokeDeviceToken(userId: string, id: string): string | null {
    const row = this.db
      .query("SELECT token FROM device_tokens WHERE id=? AND user_id=?")
      .get(id, userId) as { token: string } | null;
    if (!row) return null;
    this.db.run("DELETE FROM device_tokens WHERE id=? AND user_id=?", [
      id,
      userId,
    ]);
    return row.token;
  }

  /** Delete device tokens unused for `maxAgeMs` (counting from creation if
   *  never used). Returns how many were removed. Runs on a leaked/forgotten
   *  token so it cannot live forever. */
  pruneStaleDeviceTokens(maxAgeMs = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    return this.db.run(
      "DELETE FROM device_tokens WHERE COALESCE(last_used_at, created_at) < ?",
      [cutoff],
    ).changes;
  }

  // --- API keys: third-party clients acting on a user's notes ---

  mintApiKey(userId: string, label: string): { id: string; key: string } {
    const id = crypto.randomUUID();
    const key = `chk_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    this.db.run(
      "INSERT INTO api_keys (id, key, user_id, label, created_at) VALUES (?,?,?,?,?)",
      [id, key, userId, label, Date.now()],
    );
    return { id, key };
  }

  userForApiKey(key: string): string | null {
    if (!key.startsWith("chk_")) return null;
    const row = this.db
      .query("SELECT user_id FROM api_keys WHERE key=?")
      .get(key) as { user_id: string } | null;
    if (!row) return null;
    // record last use, throttled to ~once/min (powers "last used" in the UI)
    const now = Date.now();
    this.db.run(
      "UPDATE api_keys SET last_used_at=? WHERE key=? AND (last_used_at IS NULL OR last_used_at < ?)",
      [now, key, now - 60_000],
    );
    return row.user_id;
  }

  /** Keys for a user. Returns the full key (owner-only session) so the UI can
   *  mask it but still offer copy; the raw value is never rendered on screen. */
  listApiKeys(userId: string): {
    id: string;
    label: string;
    token: string;
    preview: string;
    createdAt: number;
    lastUsedAt: number | null;
  }[] {
    return (
      this.db
        .query(
          "SELECT id, key, label, created_at, last_used_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC",
        )
        .all(userId) as {
        id: string;
        key: string;
        label: string;
        created_at: number;
        last_used_at: number | null;
      }[]
    ).map((r) => ({
      id: r.id,
      label: r.label,
      token: r.key,
      preview: `${r.key.slice(0, 12)}…${r.key.slice(-4)}`,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  /** Revoke an API key by id. Returns the deleted RAW key (so the caller can
   *  close any live WebSocket still authenticated with it, #65), or null if no
   *  such key belonged to this user. */
  revokeApiKey(userId: string, id: string): string | null {
    const row = this.db
      .query("SELECT key FROM api_keys WHERE id=? AND user_id=?")
      .get(id, userId) as { key: string } | null;
    if (!row) return null;
    this.db.run("DELETE FROM api_keys WHERE id=? AND user_id=?", [id, userId]);
    return row.key;
  }

  // --- opt-in failure reports (telemetry; per-user isolated) ---

  /** Store a redacted failure report under the user's namespace. Idempotent
   *  on the client-supplied id (a retry of the same report is a no-op). */
  putFailureReport(userId: string, r: StoredFailureReport): void {
    this.db.run(
      `INSERT OR IGNORE INTO failure_reports
             (id, user_id, kind, tag, message, app_version, source, doc_hash, page_hash, context, occurred_at, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        r.id,
        userId,
        r.kind,
        r.tag,
        r.message,
        r.appVersion,
        r.source,
        r.docHash ?? null,
        r.pageHash ?? null,
        r.context ?? null,
        r.occurredAt,
        Date.now(),
      ],
    );
    // Bound storage: keep only the newest N per user. Without this the table is
    // unbilled + uncapped (proved: ~25 GB/user/day), and the read side only ever
    // shows 200 anyway. Ring-buffer the reports instead of growing forever.
    this.db.run(
      `DELETE FROM failure_reports WHERE user_id=? AND id NOT IN (
         SELECT id FROM failure_reports WHERE user_id=? ORDER BY created_at DESC LIMIT 200)`,
      [userId, userId],
    );
  }

  /** A user's own failure reports, newest first (the "view my reports" UX). */
  listFailureReports(userId: string, limit = 200): FailureReportRow[] {
    return this.db
      .query(
        `SELECT id, kind, tag, message, app_version AS appVersion, source,
                        doc_hash AS docHash, page_hash AS pageHash, context,
                        occurred_at AS occurredAt, created_at AS createdAt
                 FROM failure_reports WHERE user_id=? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, limit) as FailureReportRow[];
  }

  /** Clear a user's own reports; returns how many were removed. */
  clearFailureReports(userId: string): number {
    return this.db.run("DELETE FROM failure_reports WHERE user_id=?", [userId])
      .changes;
  }

  // ----- durability: backups (#38) -----

  /**
   * Take a consistent point-in-time backup into `destDir/<timestamp-seq>/`:
   * a VACUUM INTO snapshot of the DB (transaction-safe even under WAL) plus a
   * copy of the on-disk blob tree. Returns the created backup directory.
   */
  backup(destDir: string): string {
    return publishBackup(this.db, this.filesDir, destDir);
  }

  /** Keep only the most recent `keep` backups in `destDir`; delete older. */
  pruneBackups(destDir: string, keep: number): void {
    if (!existsSync(destDir) || keep < 0) return;
    // names are `<ISO ts>-<seq>` -> lexicographic sort is chronological
    const dirs = readdirSync(destDir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}T.*-\d{6}$/.test(n))
      .sort();
    for (const old of dirs.slice(0, Math.max(0, dirs.length - keep))) {
      rmSync(join(destDir, old), { recursive: true, force: true });
    }
  }
}

export interface StoredFailureReport {
  id: string;
  kind: string;
  tag: string;
  message: string;
  appVersion: string;
  source: string;
  docHash?: string | null;
  pageHash?: string | null;
  /** small JSON string of non-sensitive context */
  context?: string | null;
  occurredAt: number;
}

export interface FailureReportRow extends StoredFailureReport {
  createdAt: number;
}
