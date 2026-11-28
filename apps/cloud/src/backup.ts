import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function verifyAndSyncBlob(path: string, size: number, digest: string | null, buffer: Uint8Array): void {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    const invalid = () => new Error(`Backup blob differs from its saved revision: ${win32.basename(path)}`);
    if (!stat.isFile() || stat.size !== size) throw invalid();
    if (digest !== null) {
      const hash = new Bun.CryptoHasher("sha256");
      for (let count = readSync(fd, buffer); count > 0; count = readSync(fd, buffer)) {
        hash.update(buffer.subarray(0, count));
      }
      if (hash.digest("hex") !== digest) throw invalid();
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A source blob can change after the database capture. Verify the copied
 * bytes against the captured rows before making the archive visible. */
export function publishBackup(db: Database, filesDir: string, destDir: string): string {
  destDir = resolve(destDir);
  const created = mkdirSync(destDir, { recursive: true });
  const staging = mkdtempSync(join(destDir, ".incomplete-"));
  try {
    const dbPath = join(staging, "weft.db");
    db.run("VACUUM INTO ?", [dbPath]);
    const capture = new Database(dbPath, { readonly: true });
    const files = join(staging, "files");
    const snapshots = join(files, "snapshots");
    try {
      mkdirSync(snapshots, { recursive: true });
      const buffer = new Uint8Array(128 * 1024);
      const blobs = capture.query<
        { folder: "" | "snapshots"; path: string; size: number; digest: string | null },
        []
      >(`SELECT '' AS folder, path, size, etag AS digest FROM files
         UNION ALL SELECT 'snapshots', path, size, sha256 FROM page_snapshots`);
      for (const blob of blobs.iterate()) {
        const name = win32.basename(blob.path);
        if (name.length !== 64 || /[^0-9a-f]/.test(name)) {
          throw new Error("Invalid stored blob name in backup database");
        }
        const copy = join(files, blob.folder, name);
        copyFileSync(join(filesDir, blob.folder, name), copy, constants.COPYFILE_EXCL);
        verifyAndSyncBlob(copy, blob.size, blob.digest, buffer);
      }
    } finally {
      capture.close();
    }

    // VACUUM INTO does not guarantee the copied database is fsynced. Flush
    // every staged file and then its ancestors before exposing the archive.
    for (const path of [dbPath, snapshots, files, staging]) syncPath(path);

    const prefix = new Date().toISOString().replace(/[:.]/g, "-") + "-";
    let nextSeq = 0;
    for (const name of readdirSync(destDir)) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      if (/^\d{6}$/.test(suffix)) nextSeq = Math.max(nextSeq, Number(suffix) + 1);
    }
    for (let seq = nextSeq; seq < 1_000_000; seq++) {
      const dir = join(destDir, `${prefix}${String(seq).padStart(6, "0")}`);
      if (existsSync(dir)) continue;
      try {
        renameSync(staging, dir);
      } catch (error) {
        // Another publisher can claim the name after our check. A completed
        // archive is nonempty, so rename cannot replace it.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        continue;
      }
      try {
        // The caller can prune older archives only after the rename is
        // durable, including any ancestors mkdir just created.
        const ancestor = created ? dirname(created) : destDir;
        for (let path = destDir; ; path = dirname(path)) {
          syncPath(path);
          if (path === ancestor) break;
        }
      } catch (error) {
        renameSync(dir, staging); // do not leave an unconfirmed archive in rotation
        throw error;
      }
      return dir;
    }
    throw new Error("No free backup name for the current timestamp");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
